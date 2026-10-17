import { randomUUID } from "node:crypto";
import { dotMemorySchema, type DotMemory, type DotMemoryScope } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

/**
 * Dot memories (Space Dots Stage 5). A Dot sees its own DOT memories, its
 * PROJECT memories for the current project, and SHARED memories. Deletion
 * removes the row, including its embedding.
 */
export interface DotMemoryRepository {
  create(input: { ownerUserId: string; dotId: string | null; scope: DotMemoryScope; projectKey: string | null; text: string;
    source: "USER" | "DOT"; sourceRef: string | null; embedding: number[] | null }): Promise<DotMemory>;
  /** Memories this Dot can see, newest first; `projectKey` limits PROJECT memories to one project. */
  list(owner: string, dotId: string, filter: { scope?: DotMemoryScope; projectKey?: string | null; q?: string; limit: number }): Promise<DotMemory[]>;
  get(owner: string, dotId: string, memoryId: string): Promise<DotMemory | null>;
  /** Replaces the text; the source records who changed it last. */
  update(owner: string, dotId: string, memoryId: string, text: string, embedding: number[] | null, editor?: { source: "USER" | "DOT"; sourceRef: string | null }): Promise<DotMemory | null>;
  /** Real deletion; true when a visible memory was removed. */
  delete(owner: string, dotId: string, memoryId: string): Promise<boolean>;
  /** Most relevant memories for a query: by embedding when both sides have one of the same size, else by text. */
  recall(owner: string, dotId: string, projectKey: string | null, query: { text: string; embedding: number[] | null }, limit: number): Promise<DotMemory[]>;
  dispose(): Promise<void>;
}
const columns = `memory_id AS "memoryId", dot_id AS "dotId", scope, project_key AS "projectKey", text, source, source_ref AS "sourceRef",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
/** Rows visible to a Dot ($1 owner, $2 Dot). PROJECT rows of other projects stay hidden unless a project filter allows them. */
const visible = `owner_user_id=$1 AND (dot_id=$2 OR scope='SHARED')`;
function memory(row: Record<string, unknown>): DotMemory {
  return dotMemorySchema.parse({ ...row, createdAt: new Date(row.createdAt as string).toISOString(), updatedAt: new Date(row.updatedAt as string).toISOString() });
}
const vector = (values: number[] | null) => values && values.length && values.every(Number.isFinite) ? `[${values.join(",")}]` : null;

export class PostgresDotMemoryRepository implements DotMemoryRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotMemoryRepository(createSpacePgPool(url, { max: 2 })); }
  private async rows(sql: string, params: unknown[]) { return (await this.pool.query<Record<string, unknown>>(sql, params)).rows.map(memory); }
  async create(input: Parameters<DotMemoryRepository["create"]>[0]) {
    const memoryId = `dot_memory:${randomUUID().replace(/-/g, "")}`;
    return (await this.rows(`INSERT INTO dot_memories(memory_id,owner_user_id,dot_id,scope,project_key,text,source,source_ref,embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector) RETURNING ${columns}`, [memoryId, input.ownerUserId, input.dotId, input.scope, input.projectKey,
      input.text, input.source, input.sourceRef, vector(input.embedding)]))[0]!;
  }
  async list(owner: string, dotId: string, filter: Parameters<DotMemoryRepository["list"]>[2]) {
    const terms = (filter.q ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
    return this.rows(`SELECT ${columns} FROM dot_memories WHERE ${visible}
      AND ($3::text IS NULL OR scope=$3) AND ($4::text IS NULL OR scope<>'PROJECT' OR project_key=$4)
      AND (cardinality($5::text[])=0 OR (SELECT bool_and(text ILIKE '%' || replace(replace(term,'%','\\%'),'_','\\_') || '%') FROM unnest($5::text[]) term))
      ORDER BY updated_at DESC, memory_id LIMIT $6`, [owner, dotId, filter.scope ?? null, filter.projectKey ?? null, terms, Math.min(200, Math.max(1, filter.limit))]);
  }
  async get(owner: string, dotId: string, memoryId: string) {
    return (await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${visible} AND memory_id=$3`, [owner, dotId, memoryId]))[0] ?? null;
  }
  async update(owner: string, dotId: string, memoryId: string, text: string, embedding: number[] | null, editor?: { source: "USER" | "DOT"; sourceRef: string | null }) {
    return (await this.rows(`UPDATE dot_memories SET text=$4, embedding=$5::vector, source=COALESCE($6, source), source_ref=CASE WHEN $6::text IS NULL THEN source_ref ELSE $7 END
      WHERE ${visible} AND memory_id=$3 RETURNING ${columns}`,
      [owner, dotId, memoryId, text, vector(embedding), editor?.source ?? null, editor?.sourceRef ?? null]))[0] ?? null;
  }
  async delete(owner: string, dotId: string, memoryId: string) {
    return (await this.pool.query(`DELETE FROM dot_memories WHERE ${visible} AND memory_id=$3 RETURNING memory_id`, [owner, dotId, memoryId])).rows.length === 1;
  }
  async recall(owner: string, dotId: string, projectKey: string | null, query: { text: string; embedding: number[] | null }, limit: number) {
    const scoped = `${visible} AND (scope<>'PROJECT' OR project_key=$3)`;
    const bounded = Math.min(50, Math.max(1, limit));
    const embedding = vector(query.embedding);
    const semantic = embedding ? await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${scoped}
      AND embedding IS NOT NULL AND vector_dims(embedding)=$5 ORDER BY embedding <=> $4::vector LIMIT $6`,
      [owner, dotId, projectKey, embedding, query.embedding!.length, bounded]) : [];
    if (semantic.length >= bounded) return semantic;
    // Text matches fill the rest, so memories without an embedding are still found.
    const terms = query.text.split(/\s+/).filter((term) => term.length > 1).slice(0, 8);
    const lexical = await this.rows(`SELECT ${columns} FROM dot_memories WHERE ${scoped}
      AND (cardinality($4::text[])=0 OR (SELECT bool_or(text ILIKE '%' || replace(replace(term,'%','\\%'),'_','\\_') || '%') FROM unnest($4::text[]) term))
      ORDER BY updated_at DESC, memory_id LIMIT $5`, [owner, dotId, projectKey, terms, bounded]);
    const seen = new Set(semantic.map((item) => item.memoryId));
    return [...semantic, ...lexical.filter((item) => !seen.has(item.memoryId))].slice(0, bounded);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
