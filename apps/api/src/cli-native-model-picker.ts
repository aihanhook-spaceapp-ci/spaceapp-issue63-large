import type { PaneCliModelSettings } from "@space/contracts";
import { parseCliModelsTsv } from "./chat-providers.js";
import { execFileInProcessGroup } from "./process-group-exec.js";
import { createStaleWhileRevalidateCache } from "./stale-while-revalidate.js";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";

type Model = PaneCliModelSettings["models"][number];
type Screen = { text: string; revision: number };
// readUndimmed: the same screen with faint cells blanked. Claude Code draws its
// prompt suggestion as faint text in an empty composer; only that read can tell
// it apart from a draft the user typed.
type NativeControl = { runtimeId: string; read: () => Promise<Screen>; write: (data: string) => Promise<unknown>; assertCurrent: () => Promise<void>; wait?: (ms: number) => Promise<void>; readUndimmed?: () => Promise<string> };
/** Pane picks are namespaced so a persisted pick is never confused with the runtime's generic default id. */
export const CLAUDE_PANE_MODEL_PREFIX = "claude:";
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const cursorFamilyName = (name: string) => name.replace(/(?:\s+(?:\d+(?:\.\d+)?[MK]|Extra High|None|Low|Medium|High|Thinking|Fast|Max))+$/i, "").trim();
const geminiFamilyName = (name: string) => name.replace(/\s*\((?:Extra High|None|Low|Medium|High|Thinking|Fast|Max)\)\s*$/i, "").trim();

function nativeSettingsMenu(screen: string): boolean {
  // Cursor can retain a rendered model list above its next composer. Only the
  // interaction at the bottom is active; old transcript menus need no Escape.
  // Claude's menu keeps its key hints when PgDn scrolls its title away.
  const lastPrompt = [...screen.matchAll(/^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→)\s*(.*)$/gm)].at(-1);
  const menu = [...screen.matchAll(/Select (?:a )?model|Select thinking effort|Type to filter[\s\S]*?Tab to\s+edit|Edit\s+P\s*a\s*r\s*a\s*m\s*e\s*t\s*e\s*r\s*s[\s\S]*?Esc to go\s+back|Changes apply to this session only|Enter to set as default/gi)].at(-1);
  return Boolean(menu && (!lastPrompt || menu.index! + menu[0].length > lastPrompt.index! || /Select (?:a )?model|Select thinking effort/i.test(menu[0])));
}

function nativeApprovalOrTurn(screen: string): boolean {
  return /esc(?:ape)?\s+to\s+interrupt|ctrl\+c to interrupt|allow (?:once|always)|approve this|do you want to proceed/i.test(screen);
}

function nativePromptDraft(text: string, runtimeId: string): string | undefined {
  const promptLines = text.split('\n');
  const promptAt = runtimeId === 'cli:omp'
    ? promptLines.findLastIndex(line => /^\s*╰─\s*/u.test(line))
    : promptLines.findLastIndex(line => /^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→)\s*/u.test(line));
  let prompt = promptLines[promptAt]?.replace(/^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→|╰─)\s*/u, '').replace(/\s*[│┃]\s*$/, '').trim();
  if (runtimeId === 'cli:cursor' && prompt && !prompt.startsWith('/')) {
    for (const next of promptLines.slice(promptAt + 1, promptAt + 4)) {
      if (!/^\s+\S/.test(next) || /Run Everything|Ask Every Time|^[\s│┃╭╰─]*$/u.test(next)) break;
      prompt += ` ${next.trim()}`;
    }
  }
  if (runtimeId === 'cli:omp' && prompt && promptAt >= 0) {
    for (const next of promptLines.slice(promptAt + 1)) {
      if (/^\s*[❯›>π╭╰]/.test(next) || !next.trim()) break;
      prompt += ` ${next.trim()}`;
    }
  }
  return prompt;
}

/** Model controls may replace a native settings menu, never a user prompt or approval. */
export async function prepareNativeCliSettings(input: NativeControl): Promise<Screen> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await input.assertCurrent();
  let screen = await input.read();
  if (nativeApprovalOrTurn(screen.text)) {
    throw new SpaceConflictError('Finish the current CLI turn or dialog before changing model settings.');
  }
  for (let attempt = 0; nativeSettingsMenu(screen.text) && attempt < 3; attempt++) {
    await input.assertCurrent(); await input.write('\u001b'); await wait(350); screen = await input.read();
    if (nativeApprovalOrTurn(screen.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing model settings.');
  }
  if (nativeSettingsMenu(screen.text)) throw new SpaceConflictError('Close the native model menu before changing settings.');
  let prompt = nativePromptDraft(screen.text, input.runtimeId);
  if (prompt && input.runtimeId === 'cli:claude' && input.readUndimmed) {
    prompt = nativePromptDraft(await input.readUndimmed(), input.runtimeId);
  }
  // Escape can restore a previous settings command. A normal draft is never
  // cleared, even when a previous picker attempt failed.
  if (prompt && /^\/(?:model|effort|reasoning|thinking|switch)(?:\s|$)/.test(prompt)) {
    await input.assertCurrent(); await input.write('\u0015'); await wait(250); screen = await input.read();
  } else if (prompt && !(input.runtimeId === 'cli:gemini' && /^(?:Accept-edits|Plan|Default) mode: /.test(prompt)) && !(input.runtimeId === 'cli:hermes' && [
    'Ask me anything…', 'Try "explain this codebase"', 'Try "write a test for…"',
    'Try "refactor the auth module"', 'Try "/help" for commands',
    'Try "fix the lint errors"', 'Try "how does the config loader work?"'
  ].some(placeholder => prompt.length >= 12 && placeholder.startsWith(prompt))) && !/^(?:Ask anything(?:\.{3}|…)?|Ask (?:Cursor|Codex) to do anything|Plan, search, build(?: anything)?|Type your message(?:\.{3}|…)?|Send a message(?:\.{3}|…)?|Try "\/help" for(?: commands)?|(?:Accept-edits|Plan|Default) mode: [^\n]*\.\.\.)$/i.test(prompt)) {
    throw new SpaceConflictError('Send or clear the current CLI draft before changing model settings.');
  }
  return screen;
}

async function cleanupNativeSettingsMenu(input: NativeControl): Promise<void> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.assertCurrent();
    const screen = (await input.read()).text;
    if (input.runtimeId === 'cli:omp' && /╰─[^\n]*\/switch/i.test(screen)) {
      await input.write('\u0015'); await wait(250);
      return;
    }
    if (nativeApprovalOrTurn(screen) || !nativeSettingsMenu(screen)) return;
    await input.write('\u001b'); await wait(250);
  }
}

/** Cursor lays out its model footer in a narrow column beside its mode. */
function cursorFooter(screen: string): string | null {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]!.trim().match(/^(?:(.*?)\s{2,})?(?:Run Everything|Ask Every Time)\s*$/);
    if (!match) continue;
    let model = match[1] ?? '';
    if (!model) {
      // At twenty columns Ink can allocate one character to the model column.
      const groups: string[] = [];
      let group = '';
      for (const next of lines.slice(i + 1)) {
        const part = next.trim();
        if (part.startsWith('/') || /^[╭╰│┃→❯›>]/u.test(part)) break;
        if (!part) { if (group) groups.push(group); group = ''; }
        else group += part;
      }
      if (group) groups.push(group);
      return groups.join(' ').replace(/\[\d+m/g, '').replace(/\s+/g, ' ').trim();
    }
    for (const next of lines.slice(i + 1)) {
      const part = next.trim();
      if (!part) continue;
      if (part.startsWith('/') || /^[╭╰│┃→❯›>]/u.test(part)) break;
      // Ink wraps a word in the middle when its footer column is very narrow.
      model += /[.-]$/.test(model) || /^\d/.test(part) && /\d$/.test(model) ? part : ` ${part}`;
    }
    return model;
  }
  return null;
}

export function nativeCliReasoningLevels(commandPath: string, model: Model): string[] {
  if (commandPath.endsWith('/deepseek-vscode-parity')) return ['auto', ...model.supportedReasoningEfforts.filter(e => e !== 'none')];
  if (commandPath.endsWith('/kimi-vscode-parity') && /^kimi-code\/k3(?:-256k)?$/.test(model.id)) return ['low', 'high', 'max'];
  if (commandPath.endsWith('/grok-vscode-parity')) return ['low', 'medium', 'high', 'xhigh'];
  if (commandPath.endsWith('/hermes-vscode-parity')) return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  // Claude Code's /model menu offers these levels for every family (PTY-verified on 2.1.296).
  if (commandPath.endsWith('/claude-vscode-parity')) return [...CLAUDE_EFFORT_LEVELS];
  if (commandPath.endsWith('/omp-vscode-parity')) return model.supportedReasoningEfforts.filter(e => e !== 'none');
  return [];
}

export function nativeCliCatalogModels(commandPath: string, raw: string): Model[] {
  const advertised = parseCliModelsTsv(raw);
  const families = new Map<string, Model>();
  const isCursor = commandPath.endsWith("/cursor-vscode-parity");
  const isGemini = commandPath.endsWith("/gemini-vscode-parity");
  const isClaude = commandPath.endsWith("/claude-vscode-parity");
  for (const model of advertised) {
    const efforts = nativeCliReasoningLevels(commandPath, model);
    const displayName = isCursor
      ? cursorFamilyName(model.displayName)
      : isGemini
        ? geminiFamilyName(model.displayName)
        : model.displayName;
    const id = isCursor
      ? `cursor-family:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      : isGemini
        ? model.id.replace(/-(low|medium|high|thinking)$/, "")
        : isClaude && !model.id.startsWith(CLAUDE_PANE_MODEL_PREFIX)
          ? `${CLAUDE_PANE_MODEL_PREFIX}${model.id}`
          : model.id;

    if (isGemini) {
      const variantEffort = model.id.match(/-(low|medium|high)$/)?.[1]
        ?? (model.displayName.match(/\b(Low|Medium|High|Thinking)\b/i)?.[1]?.toLowerCase());
      if (variantEffort) {
        const normalizedEffort = variantEffort === "thinking" ? "high" : variantEffort;
        if (!efforts.includes(normalizedEffort)) efforts.push(normalizedEffort);
      }
      const previous = families.get(id);
      if (previous) {
        for (const eff of efforts) {
          if (!previous.supportedReasoningEfforts.includes(eff)) {
            previous.supportedReasoningEfforts.push(eff);
            previous.reasoningOptions?.push({ reasoningEffort: eff });
          }
        }
      }
    }
    if (isCursor) {
      const variantEffort = model.displayName.match(/\b(Extra High|None|Low|Medium|High|Max)(?:\s+Fast)?$/i)?.[1]?.toLowerCase().replace('extra high', 'xhigh')
        ?? model.id.match(/-(extra-high|none|low|medium|high|max)(?:-fast)?$/)?.[1]?.replace('extra-high','xhigh');
      if (variantEffort) efforts.push(variantEffort);
      const previous = families.get(id);
      if (previous && variantEffort && !previous.supportedReasoningEfforts.includes(variantEffort)) {
        previous.supportedReasoningEfforts.push(variantEffort);
        previous.reasoningOptions?.push({ reasoningEffort: variantEffort });
      }
    }
    if (!families.has(id)) {
      families.set(id, {
        ...model,
        id,
        displayName,
        defaultReasoningEffort: isGemini
          ? (efforts.includes("high") ? "high" : efforts[0] ?? "none")
          : efforts.includes(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : efforts[0] ?? "none",
        supportedReasoningEfforts: efforts.length ? [...efforts] : ["none"],
        reasoningOptions: efforts.map((reasoningEffort) => ({ reasoningEffort }))
      });
    }
  }
  return [...families.values()].map(model => {
    const order = ['auto','none','disabled','minimal','low','medium','high','xhigh','max','ultra'];
    model.supportedReasoningEfforts.sort((a,b) => order.indexOf(a) - order.indexOf(b));
    model.reasoningOptions?.sort((a,b) => order.indexOf(a.reasoningEffort) - order.indexOf(b.reasoningEffort));
    if (commandPath.endsWith('/cursor-vscode-parity') && model.supportedReasoningEfforts.includes('medium')) model.defaultReasoningEffort = 'medium';
    if (commandPath.endsWith('/gemini-vscode-parity') && model.supportedReasoningEfforts.includes('high')) model.defaultReasoningEffort = 'high';
    // Space starts Claude Code with effortLevel xhigh (claude-space-settings.json).
    if (commandPath.endsWith('/claude-vscode-parity') && model.supportedReasoningEfforts.includes('xhigh')) model.defaultReasoningEffort = 'xhigh';
    return model;
  });
}

/**
 * The catalog is advertised whole to the picker: slicing it here silently
 * dropped models the CLI had already advertised (Reasonix now returns 300+),
 * which made the picker offer a different set than the API had parsed.
 * The transport owns the byte bound instead (`nativeCliCatalogBufferBytes`).
 */
export const nativeCliCatalogBufferBytes = 8 * 1024 * 1024;

function nativeControlScreen(screen: string, runtimeId: string): string {
  // Reasonix draws a scrollbar at the right edge of every transcript row.
  return runtimeId === 'cli:deepseek' || runtimeId === 'cli:hermes' ? screen.replace(/[ \t]*[│┃█][ \t]*$/gm, '') : screen;
}

export function nativeCliConfirmedReasoning(screen: string, runtimeId: string, model?: Model): string | null {
  screen = nativeControlScreen(screen, runtimeId);
  if (runtimeId === 'cli:deepseek') {
    screen = screen.replace(/(effort for[^\n]*)(?:\n([^·❯›>─\n][^\n]*)){0,3}/g, value => value.replace(/\n/g, ' '));
  }
  if (runtimeId === 'cli:gemini') {
    const footer = screen.match(/(?:^|·)\s*Gemini [^·\n]+\s*·\s*(low|medium|high)\s*$/im);
    if (footer) return footer[1]!.toLowerCase();
    const setMsg = screen.match(/Model set to [^(\n]+\((High|Medium|Low)\)/i);
    if (setMsg) return setMsg[1]!.toLowerCase();
    if (model?.reasoningOptions?.length) return model.defaultReasoningEffort;
  }
  if (runtimeId === 'cli:claude') {
    // Claude Code 2.1 keeps the live effort in its footer ("◉ xhigh · /effort", "○ low · /effort"),
    // a session-only /model pick ("Set model to Opus 5.5 for this session only with high effort"),
    // an /effort acknowledgement and its banner ("Opus 5.5 with xhigh effort"). The newest wins.
    for (const raw of screen.split(/\r?\n/).reverse()) {
      const footer = raw.match(/(?:^|\s)\S\s+(auto|low|medium|high|xhigh|max)\s+·\s+\/effort\s*$/i)?.[1];
      if (footer) return footer.toLowerCase();
      const line = raw.trim().replace(/^[│┃·●⎿✓]\s*/, '');
      if (/^[❯›>]/u.test(line) || /not applied|overrides|still controls|blocked|couldn't/i.test(line)) continue;
      const value = line.match(/^(?:Set effort level to|Current effort level:|Effort level set to)\s*(auto|low|medium|high|xhigh|max)\b/i)?.[1]
        ?? line.match(/\bwith\s+(low|medium|high|xhigh|max)\s+effort\b/i)?.[1];
      if (value) return value.toLowerCase();
    }
    return null;
  }
  if (runtimeId === 'cli:cursor') {
    const footer = cursorFooter(screen);
    if (footer) return footer.replace(/\s/g, '').match(/(ExtraHigh|None|Low|Medium|High|Max)(?:Fast)?$/i)?.[1]?.toLowerCase().replace('extrahigh', 'xhigh') ?? null;
  }
  for (const raw of screen.split(/\r?\n/).reverse()) {
    const line = raw.trim().replace(/^[│┃·●⎿✓]\s*/, '');
    if (/\/(?:effort|thinking|reasoning|switch)\b|unknown|invalid|error/i.test(line)) continue;
    if (runtimeId === 'cli:omp' && /^\s*╰─/u.test(line)) continue;
    if (runtimeId === 'cli:grok') {
      // Grok clips its footer against the closing border at small widths.
      // A visible effort prefix is usable only when it identifies one level.
      const prefix = line.match(/^╰─+\s*Grok [\d.]+\s*\(([a-z]+)─+╯$/i)?.[1]?.toLowerCase();
      if (prefix) {
        const matches = ['low', 'medium', 'high', 'xhigh'].filter(effort => effort.startsWith(prefix));
        if (matches.length === 1) return matches[0]!;
      }
    }
    if (runtimeId === 'cli:omp') {
      const glyphMatch = line.match(/^π\s*>\s*(?:([o○◔◑◒◕◉⟳]|\[[^\]]+\])\s+)?([^>]+?)\s*>/)?.[1];
      if (glyphMatch) {
        const g = glyphMatch.toLowerCase();
        if (g === 'o' || g === '○' || g === '[min]') return 'minimal';
        if (g === '◔' || g === '[low]') return 'low';
        if (g === '◑' || g === '[med]') return 'medium';
        if (g === '◒' || g === '[high]') return 'high';
        if (g === '◕' || g === '[xhi]') return 'xhigh';
        if (g === '◉' || g === '[max]') return 'max';
        if (g === '⟳' || g === '[~]') return 'auto';
      }
      const effortMatch = line.match(/(?:\bthinking:\s*|\bthinking level:\s*|\bthinking\s+)(auto|off|minimal|low|medium|high|max|xhigh)\b/i)?.[1];
      if (effortMatch) return effortMatch.toLowerCase();
    }
    const value = runtimeId === 'cli:deepseek' ? line.match(/(?:\bEFFORT\s+|effort for .+? set to\s+)(auto|disabled|low|medium|high|xhigh|max)\b/)?.[1]
      : runtimeId === 'cli:kimi' ? line.match(/(?:\bthinking:\s*|^Thinking set to\s+)(low|high|max)\b/i)?.[1]
      : runtimeId === 'cli:grok' ? line.match(/Grok [\d.]+\s*\((low|medium|high|xhigh)\)/i)?.[1]
      : runtimeId === 'cli:hermes' ? line.match(/^reasoning:\s*(none|minimal|low|medium|high|xhigh|max|ultra)\b/i)?.[1]
      : runtimeId === 'cli:cursor' && /\s{2,}(?:Run Everything|Ask Every Time)\s*$/.test(line) ? line.match(/\b(Extra High|None|Low|Medium|High|Max)(?:\s+Fast)?\s{2,}/i)?.[1]?.replace(/extra high/i,'xhigh')
      : null;
    if (value) return value.toLowerCase();
  }
  return null;
}

async function applyNativeCliReasoning(input: {
  runtimeId: string; effort: string; model: Model;
  read: () => Promise<Screen>; write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>; wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.model.supportedReasoningEfforts.includes(input.effort)) throw new SpaceConflictError('This reasoning level is not supported by the selected model.');
  if (input.effort === 'none' && input.model.reasoningOptions?.length === 0) return;
  if (input.runtimeId === 'cli:cursor' && input.model.reasoningOptions?.length) return switchCursorReasoning(input);
  const prefix = ({'cli:deepseek':'/effort', 'cli:grok':'/effort', 'cli:claude':'/effort', 'cli:kimi':'/thinking', 'cli:hermes':'/reasoning'} as Record<string,string>)[input.runtimeId];
  if (!prefix) {
    if (input.runtimeId === 'cli:omp') {
      const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const before = await prepareNativeCliSettings(input);
      if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
      await input.write(`/switch ${input.model.id}:${input.effort}\r`);
      for (let i = 0; i < 40; i++) {
        await wait(250); await input.assertCurrent();
        const after = await input.read();
        if (after.revision === before.revision) continue;
        const confirmed = nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model);
        if (confirmed === input.effort) return;
        if (/unknown command|unrecognized command|invalid (?:slash command|model|effort|reasoning)|model (?:not found|unavailable)|error:\s*(?:unknown model|invalid)/i.test(after.text)) {
          throw new SpaceConflictError('The CLI rejected this reasoning level.');
        }
        if (/╰─[^\n]*\/switch/i.test(after.text)) {
          await input.assertCurrent();
          await input.write('\r');
        }
        if (!confirmed && nativeCliConfirmedModel(after.text, [input.model], input.runtimeId) === input.model.id
          && !/╰─[^\n]*\/switch/i.test(after.text)
          && /Session-only model:/i.test(after.text)) {
          return;
        }
      }
      throw new SpaceConflictError('The CLI has not confirmed the reasoning change. Check its current settings.');
    }
    if (input.effort !== 'none') throw new SpaceConflictError('This CLI does not expose a separate reasoning control.');
    return;
  }
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing reasoning.');
  const command = input.runtimeId === 'cli:kimi' ? prefix : `${prefix} ${input.effort}`;
  await input.write(command + (input.runtimeId === 'cli:deepseek' ? ' ' : ''));
  await wait(250); await input.assertCurrent(); await input.write('\r');
  let submitted = false;
  let kimiSelection = nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) ?? undefined;
  for (let i = 0; i < 40; i++) {
    await wait(250); await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    if ((!nativeSettingsMenu(after.text) || input.runtimeId !== 'cli:kimi') && nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model) === input.effort) return;
    if (/unknown command|invalid (?:effort|reasoning)|unsupported effort/i.test(after.text)) throw new SpaceConflictError('The CLI rejected this reasoning level.');
    if (!submitted && input.runtimeId === 'cli:deepseek' && after.text.split('\n').some(l => l.trim() === `❯ ${command}`)) { await input.write('\r'); submitted = true; }
    if (!submitted && input.runtimeId === 'cli:kimi' && /Select thinking effort/.test(after.text)) {
      const selected = after.text.match(/\[\s*(Low|High|Max)\b/)?.[1]?.toLowerCase() ?? kimiSelection ?? (/\bLow\s+High\b/.test(after.text) ? 'max' : undefined);
      if (selected === input.effort) { await input.write('\u001bs'); submitted = true; }
      else if (selected) {
        const levels = ['low','high','max'];
        const direction = levels.indexOf(selected) < levels.indexOf(input.effort) ? 1 : -1;
        await input.write(direction > 0 ? '\u001b[C' : '\u001b[D');
        kimiSelection = levels[levels.indexOf(selected) + direction];
      }
    }
  }
  throw new SpaceConflictError('The CLI has not confirmed the reasoning change. Check its current settings.');
}

async function switchCursorReasoning(input: Parameters<typeof switchNativeCliReasoning>[0]): Promise<void> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing reasoning.');
  await input.write('/model'); await wait(250); await input.assertCurrent(); await input.write('\r');
  let edited = false;
  let selected = false;
  let escaped = false;
  const label = input.effort === 'xhigh' ? 'Extra High' : input.effort[0]!.toUpperCase() + input.effort.slice(1);
  for (let i=0; i<70; i++) {
    await wait(250); await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    if (selected && nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model) === input.effort) return;
    if (!edited && /Type to filter[\s\S]*Tab to\s+edit/.test(after.text)) { await input.write('\t'); edited = true; continue; }
    if (edited && /Edit\s+P\s*a\s*r\s*a\s*m\s*e\s*t\s*e\s*r\s*s/.test(after.text)) {
      const rows = after.text.split('\n').filter(l => /^[\s→]*[●○◯]/.test(l));
      const active = rows.findIndex(l => l.includes('→'));
      const target = rows.findIndex(l => l.replace(/^[\s→●○◯]+/,'').replace(/\s*✓\s*$/,'').trim() === label);
      if (target < 0) { await input.write('\u001b'); await wait(250); await input.write('\u001b'); throw new SpaceConflictError('The current Cursor model does not offer this reasoning level.'); }
      if (!selected && active === target) { await input.write('\r'); selected = true; continue; }
      if (!selected && active >= 0) { await input.write(active < target ? '\u001b[B' : '\u001b[A'); continue; }
      if (selected && !escaped) { await input.write('\u001b'); escaped = true; continue; }
    }
    if (selected && /Type to filter[\s\S]*Tab to\s+edit/.test(after.text)) { await input.write('\r'); }
  }
  throw new SpaceConflictError('Cursor has not confirmed the reasoning change.');
}

/**
 * A catalog load runs the wrapper's full `models` pipeline (seconds of CPU,
 * plus the wrapper's background history merge), while catalogs change only
 * with CLI releases or account switches. Catalogs are therefore served for 15
 * minutes and then refreshed in the background while the last catalog stays
 * available; `force` bypasses the cache for explicit refreshes.
 */
export const NATIVE_CLI_MODEL_CATALOG_FRESH_MS = 15 * 60_000;
const nativeCliModelCatalogFailureTtlMs = 15_000;
const nativeCliModelCatalogTimeoutMs = 35_000;

export type NativeCliModelCatalogRunner = (
  commandPath: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string }>;

/** Only model metadata leaves the existing credential-owning CLI wrappers. */
export function createNativeCliModelCatalog(options: { run?: NativeCliModelCatalogRunner; now?: () => number } = {}) {
  // Timeouts terminate the wrapper's whole process group, not only the shell.
  const run = options.run ?? execFileInProcessGroup;
  const cache = createStaleWhileRevalidateCache<Model[]>({
    freshMs: NATIVE_CLI_MODEL_CATALOG_FRESH_MS,
    errorTtlMs: nativeCliModelCatalogFailureTtlMs,
    maxEntries: 64,
    now: options.now
  });
  const load = async (commandPath: string, accountProfileId: string | null): Promise<Model[]> => {
    try {
      const { stdout } = await run(commandPath, ["models"], {
        timeout: nativeCliModelCatalogTimeoutMs, maxBuffer: nativeCliCatalogBufferBytes,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
          ...(accountProfileId && accountProfileId !== "main"
            ? { SPACE_GEMINI_ACCOUNT_PROFILE: accountProfileId, SPACE_CURSOR_ACCOUNT_PROFILE: accountProfileId, SPACE_CLAUDE_ACCOUNT_PROFILE: accountProfileId, SPACE_COPILOT_ACCOUNT_PROFILE: accountProfileId }
            : {}) }
      });
      // Native adapters define their own effort levels; Chat metadata alone
      // does not establish support for an interactive CLI command.
      const models = nativeCliCatalogModels(commandPath, stdout);
      if (!models.length) throw new Error("empty catalog");
      return models;
    } catch {
      throw new SpaceFeatureDisabledError("CLI_MODEL_CATALOG_UNAVAILABLE", "The CLI model catalog is unavailable. Try again shortly.");
    }
  };
  return async (
    commandPath: string,
    accountProfileId: string | null = null,
    loadOptions: { force?: boolean } = {}
  ): Promise<Model[]> => {
    const key = `${commandPath}:${accountProfileId ?? ""}`;
    return cache.get(key, () => load(commandPath, accountProfileId), loadOptions);
  };
}

/** Room Agent and voice callers name models loosely ("opus", "Opus 5.5", "claude-opus-5-5"); an exact id wins. */
export function findNativeCliModel(models: readonly Model[], requested: string, runtimeId = ""): Model | undefined {
  const wanted = requested.trim().toLowerCase();
  const named = models.find((entry) => entry.id === requested) ??
    models.find((entry) => entry.id.toLowerCase() === wanted || entry.displayName.toLowerCase() === wanted);
  if (named || runtimeId !== "cli:claude") return named;
  const family = wanted.match(/\b(opus|sonnet|haiku|fable)\b/)?.[1];
  return family ? models.find((entry) => entry.id === `${CLAUDE_PANE_MODEL_PREFIX}${family}`) : undefined;
}

/** A command echo or highlighted menu entry is never confirmation. */
export function nativeCliConfirmedModel(screen: string, models: readonly Model[], runtimeId = ""): string | null {
  screen = nativeControlScreen(screen, runtimeId);
  if (runtimeId === "cli:claude") {
    // Claude Code 2.1 names the model family: "⎿ Set model to Sonnet 5.5 for this session only with
    // high effort", "… and saved as your default for new sessions", "Kept model as Fable 5.1", and its
    // banner "Opus 5.5 with xhigh effort". The newest family line decides; the catalog holds families.
    for (const raw of screen.split(/\r?\n/).reverse()) {
      const line = raw.trim().replace(/^[│┃·●⎿└]\s*/, "");
      if (/^[❯›>]/u.test(line) || /blocked|couldn't/i.test(line)) continue;
      const family = line.match(/\b(?:Set model to|Kept model as|Current model:)\s+(Opus|Sonnet|Haiku|Fable)\b/i)?.[1] ??
        line.match(/\b(Opus|Sonnet|Haiku|Fable)\s+[\d.]+(?:\s*\([^)]*\))?\s+with\s+\S+\s+effort\b/i)?.[1];
      if (!family) continue;
      const name = family.toLowerCase();
      return models.find((entry) => entry.displayName.toLowerCase() === name ||
        entry.id.toLowerCase() === name || entry.id.toLowerCase() === `${CLAUDE_PANE_MODEL_PREFIX}${name}`)?.id ?? null;
    }
    return null;
  }
  const footer = runtimeId === "cli:cursor" ? cursorFooter(screen) : null;
  const rawLines = (footer ? `${screen}\nModel: ${footer}` : screen).split(/\r?\n/);
  const lines = rawLines.map((line, index) => {
    let text = line.trim().replace(/^[│┃·●⎿└]\s*/, "");
    if (runtimeId === 'cli:gemini' && rawLines[index + 1]?.trim().startsWith('/') && models.some(model => model.displayName === text || model.displayName === geminiFamilyName(text))) text = `Model: ${text}`;
    if (/^(?:Model (?:set|changed|switched) to|Switched to|Already on|model →|Session-only model:?)/i.test(text)) {
      for (const next of rawLines.slice(index + 1, index + 7)) {
        if (!next.trim() || /^\s*[│┃╭╰─❯›>⎿└·●]/u.test(next) || /^(?:Model|Switched|Thinking set|reasoning:|EFFORT|YOLO|Ask When|Session-only)\b/i.test(next.trim())) break;
        text += /[-/]$/.test(text) ? next.trim() : ` ${next.trim()}`;
      }
    }
    return text;
  });
  for (const line of lines.reverse()) {
    if (/^\s*(?:\/(?:model|switch)\b|[❯›>→])/u.test(line)) continue;
    if (runtimeId === 'cli:omp' && /^\s*╰─/u.test(line)) continue;
    if (!/Session-only model:/i.test(line) && (/(?:^|\s)\/(?:model|switch)(?:\s|$)/i.test(line) || /(?:unknown|invalid|failed|rejected|unavailable|not found|error)\b/i.test(line))) continue;
    let modelText = line.match(/^(?:[✓✔✅*]\s*)?(?:(?:current |active )?model\s*[:→]|(?:model\s+)?(?:switched|changed|set|updated)(?:\s+model)?\s+(?:to\s*:?[ ]*)?|already on\s+|using\s+(?:model\s+)?)[ ]*(.*)$/i)?.[1];
    if (runtimeId === 'cli:gemini') {
      const footer = line.match(/(?:^|·)\s*(Gemini [^·]+)\s*·\s*(low|medium|high)\s*$/i);
      if (footer) modelText = `${footer[1]!.trim()} (${footer[2]![0]!.toUpperCase()}${footer[2]!.slice(1).toLowerCase()})`;
    }
    if (runtimeId === "cli:hermes" && /^[^│┃·]+\s*·\s*Nous Research/.test(line)) modelText ??= line.split(/\s*·\s*/)[0];
    if (runtimeId === "cli:deepseek") modelText ??= line.match(/\bMODEL\s+(.+?)\s+EFFORT\b/)?.[1];
    if (runtimeId === "cli:cursor" && /\s{2,}(?:Run Everything|Ask Every Time)\s*$/.test(line)) modelText = line.split(/\s{2,}/)[0];
    if (runtimeId === "cli:copilot" && /open sidebar.*tab next tab/i.test(line)) modelText = line.split(/\s{2,}/).at(-1);
    if (runtimeId === "cli:grok") modelText ??= line.match(/(Grok [0-9.]+)\s*\([^)]*\)\s*·/)?.[1]
      ?? line.match(/^╰─+\s*(Grok [0-9.]+)\s*\(/)?.[1];
    if (runtimeId === "cli:omp") {
      modelText ??= line.match(/(?:Session-only model:\s*|Model set to\s*|Current model:\s*)([^\s]+?)(?:\.\s|\.$|\s|$)/i)?.[1]
        ?? line.match(/^π\s*>\s*(?:([o○◔◑◒◕◉⟳]|\[[^\]]+\])\s+)?([^>]+?)\s*>/)?.[2];
    }
    if (!modelText || /^persisted\b/i.test(modelText) || /…|\.\.\./.test(modelText)) continue;
    modelText = modelText.replace(/[.,;:]+$/, "");
    if (runtimeId === "cli:omp") modelText = modelText.replace(/:(?:auto|off|minimal|low|medium|high|max|xhigh)$/i, "");
    const matched = new Set<string>();
    for (const model of models) {
      const candidateText = (runtimeId === "cli:cursor" && model.id.startsWith("cursor-family:")
        ? cursorFamilyName(modelText.trim())
        : runtimeId === "cli:gemini" && !/-(low|medium|high)$/.test(model.id)
          ? geminiFamilyName(modelText.trim())
          : modelText.trim()).replace(/\s+/g, ' ');
      const names = [model.id, model.displayName];
      if (runtimeId === "cli:gemini") names.push(geminiFamilyName(model.displayName));
      if (runtimeId === "cli:deepseek") names.push(model.id.slice(model.id.indexOf("/") + 1));
      if (runtimeId === "cli:hermes" && model.id.includes(":")) names.push(model.id.slice(model.id.indexOf(":") + 1));
      if (runtimeId === "cli:grok") names.push(model.id.replace(/^grok-/, "Grok "));
      if (runtimeId === "cli:omp" && model.id.includes("/")) names.push(model.id.split("/").slice(1).join("/"));
      for (const name of names) {
        if (runtimeId === 'cli:cursor') {
          // Ink wraps both words and tokens in a 1–8 character footer column.
          // Compare the advertised family and only known parameter suffixes.
          const compact = candidateText.replace(/\s/g, '').toLowerCase();
          const compactName = name.replace(/\s/g, '').toLowerCase();
          if (!compact.startsWith(compactName)) continue;
          const suffix = compact.slice(compactName.length);
          if (!suffix || model.id.startsWith('cursor-family:') && /^(?:\d+(?:\.\d+)?[mk]|extrahigh|none|low|medium|high|thinking|fast|max)+$/.test(suffix)) matched.add(model.id);
          continue;
        }
        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escaped = runtimeId === 'cli:deepseek' && !/\s/.test(name) ? [...name].map(escape).join('\\s*') : escape(name);
        if (new RegExp(`^["']?${escaped}(?:["']?$|["']?\\s*(?:[│┃·]|-(?:low|medium|high|thinking)|\\(|with thinking\\b|for this session\\b))`, "i").test(candidateText)) matched.add(model.id);
      }
    }
    if (matched.size === 1) return [...matched][0]!;
    if (runtimeId !== "cli:omp") return null;
  }
  return null;
}

/**
 * Claude Code's /model menu: numbered family rows ("❯ 3. Fable ✔   Fable 5.1 · …"), the effort line
 * ("◉ xHigh effort ←/→ to adjust") and its key hints. Null while no menu is drawn.
 *
 * A short pane lists only a window of the rows: "↑"/"↓" replace the cursor on its edge rows and
 * "… +3 models" counts the rows below it. A narrow pane also clips the bottom of the menu box,
 * which PgDn scrolls; the title can then leave the screen above the prompt border ("▔▔▔").
 */
export function claudeModelMenu(screen: string): {
  rows: { number: number; label: string; highlighted: boolean }[];
  effort: string | null; effortSupported: boolean; sessionOnly: boolean; searching: boolean;
  moreAbove: boolean; moreBelow: boolean; hintsVisible: boolean;
} | null {
  let start = screen.lastIndexOf("Select model");
  if (start < 0 && /Esc to cancel/i.test(screen) && screen.includes("▔")) start = screen.lastIndexOf("▔") + 1;
  if (start < 0) return null;
  const menu = screen.slice(start);
  const rows: { number: number; label: string; highlighted: boolean }[] = [];
  let effort: string | null = null;
  let moreBelow = /^\s*(?:…|\.\.\.)\s*\+\d+\s+models?\b/mu.test(menu);
  for (const line of menu.split(/\r?\n/)) {
    const row = line.match(/^\s*(?:(❯)|↑|(↓))?\s*(\d+)\.\s+(.+?)(?:\s{2,}|$)/u);
    if (row) {
      rows.push({ number: Number(row[3]), label: row[4]!.replace(/\s*✔\s*$/u, "").trim(), highlighted: Boolean(row[1]) });
      moreBelow ||= Boolean(row[2]);
      continue;
    }
    effort ??= line.match(/^\s*\S\s+(Low|Medium|High|xHigh|Max)\s+effort\b/i)?.[1]?.toLowerCase() ?? null;
  }
  return { rows, effort, effortSupported: !/Effort\s+not\s+supported/i.test(menu),
    sessionOnly: /\bs\s+to\s+use\s+this\s+session\s+only\b/i.test(menu), searching: /Type to (?:search|filter)/i.test(menu),
    moreAbove: rows.length > 0 && Math.min(...rows.map((row) => row.number)) > 1, moreBelow, hintsVisible: /Esc to cancel/i.test(menu) };
}

/**
 * `/model <name>` in Claude Code saves the pick as the default of every session sharing its config,
 * and sessions without their own pick follow that default. A pane therefore selects its model in
 * the native menu with "s" (this session only), adjusting the effort in the same menu.
 */
async function applyClaudeSessionModel(input: {
  model: Model; effort?: string; read: () => Promise<Screen>; write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>; wait?: (ms: number) => Promise<void>; runtimeId: string; readUndimmed?: () => Promise<string>;
}): Promise<void> {
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const levels: readonly string[] = CLAUDE_EFFORT_LEVELS;
  const effort = input.effort && levels.includes(input.effort) ? input.effort : undefined;
  const applied = (text: string, withEffort: boolean) =>
    nativeCliConfirmedModel(text, [input.model], "cli:claude") === input.model.id &&
    (!withEffort || !effort || nativeCliConfirmedReasoning(text, "cli:claude") === effort);
  const before = await prepareNativeCliSettings(input);
  if (applied(before.text, true)) return;
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) {
    throw new SpaceConflictError("Finish the current CLI turn or dialog before changing models.");
  }
  await input.write("/model");
  await wait(250);
  await input.assertCurrent();
  await input.write("\r");
  const family = input.model.displayName.toLowerCase();
  let actedOn = -1;
  let steps = 0;
  let pageDowns = 0;
  let seekDown = true;
  // A pane too small for the menu box never shows its rows together with its key hints.
  const tooSmall = () => new SpaceConflictError("The Claude model menu does not fit this pane. Enlarge the pane, then choose the model again.");
  let chosen: { withEffort: boolean } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(250);
    await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision || after.revision === actedOn) continue;
    if (chosen) {
      if (applied(after.text, chosen.withEffort)) return;
      continue;
    }
    if (/unknown command|unrecognized command/i.test(after.text)) throw new SpaceConflictError("The CLI rejected the model selection. Check its model menu.");
    const menu = claudeModelMenu(after.text);
    if (!menu?.rows.length) continue;
    const target = menu.rows.find((row) => row.label.toLowerCase() === family);
    const highlighted = menu.rows.find((row) => row.highlighted);
    if (menu.hintsVisible) pageDowns = 0;
    let key: string;
    if (!menu.sessionOnly && menu.searching) {
      // A menu that opens in search mode returns to its list with Down.
      key = "\u001b[B";
    } else if (!target) {
      // Rows outside a short pane's window are hidden: look below the window first, then above it.
      seekDown &&= menu.moreBelow;
      if (!seekDown && !menu.moreAbove) {
        throw menu.hintsVisible ? new SpaceConflictError("This model is not available in this Claude account's model menu. Choose another model.") : tooSmall();
      }
      key = seekDown ? "\u001b[B" : "\u001b[A";
    } else if (menu.hintsVisible && !menu.sessionOnly) {
      throw new SpaceConflictError("This Claude Code version cannot change the model for one pane only.");
    } else if (highlighted && highlighted.number !== target.number) {
      key = target.number > highlighted.number ? "\u001b[B" : "\u001b[A";
    } else if (!menu.hintsVisible) {
      // The highlight, the effort line or "s to use this session only" is below the clipped bottom of the menu box.
      if (++pageDowns > 2) throw tooSmall();
      key = "\u001b[6~";
    } else if (!highlighted || (effort && menu.effortSupported && !menu.effort)) {
      continue;
    } else if (effort && menu.effortSupported && menu.effort !== effort) {
      if (!levels.includes(menu.effort!)) throw new SpaceConflictError("The Claude model menu shows an unknown effort level.");
      key = levels.indexOf(effort) > levels.indexOf(menu.effort!) ? "\u001b[C" : "\u001b[D";
    } else {
      key = "s";
      chosen = { withEffort: menu.effortSupported };
    }
    if (++steps > 24) throw new SpaceConflictError("The Claude model menu did not follow the selection. Check its terminal.");
    actedOn = after.revision;
    await input.assertCurrent();
    await input.write(key);
  }
  throw new SpaceConflictError("Claude Code has not confirmed the model change. Check its terminal for the model menu.");
}

async function applyNativeCliModel(input: {
  model: Model;
  runtimeId: string;
  effort?: string;
  read: () => Promise<Screen>;
  write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  readUndimmed?: () => Promise<string>;
}): Promise<void> {
  if (!identifier.test(input.model.id)) throw new SpaceConflictError("The selected CLI model identifier is invalid.");
  if (input.runtimeId === "cli:claude") return applyClaudeSessionModel(input);
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedModel(before.text, [input.model], input.runtimeId) === input.model.id) {
    if ((input.runtimeId === 'cli:omp' || input.runtimeId === 'cli:gemini') && input.effort && input.effort !== 'none') {
      const confirmedEffort = nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model);
      if (confirmedEffort && confirmedEffort === input.effort) return;
    } else {
      return;
    }
  }
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) {
    throw new SpaceConflictError("Finish the current CLI turn or dialog before changing models.");
  }
  const hermesParts = input.runtimeId === "cli:hermes" ? input.model.id.split(/:(.*)/s) : null;
  let targetModel = input.model.id;
  if (input.runtimeId === "cli:cursor") {
    targetModel = input.model.displayName;
  } else if (input.runtimeId === "cli:gemini") {
    const effort = input.effort ?? input.model.defaultReasoningEffort;
    if (effort && ['low', 'medium', 'high'].includes(effort) && !/-(low|medium|high)$/.test(targetModel)) {
      targetModel = `${targetModel}-${effort}`;
    }
  }
  const command = hermesParts?.[1]
    ? `/model ${hermesParts[1]} --provider ${hermesParts[0]} --session`
    : input.runtimeId === "cli:omp"
      ? `/switch ${input.model.id}${input.effort && input.effort !== 'none' ? `:${input.effort}` : ''}`
      : `/model ${targetModel}${input.runtimeId === "cli:hermes" ? " --session" : ""}`;
  if (/[\u0000-\u001f\u007f]/.test(command)) throw new SpaceConflictError("The CLI model label contains unsupported control characters.");
  await input.write(command + (input.runtimeId === "cli:deepseek" ? " " : ""));
  await wait(250);
  await input.assertCurrent();
  await input.write("\r");
  let lastMenuRevision = -1;
  let submittedCompletion = false;
  let kimiFiltered = false;
  for (let attempt = 0; attempt < 32; attempt++) {
    await wait(250);
    await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    // The preflight ruled out this model. Confirm the newly observed complete
    // screen: narrow acknowledgements can reuse an unchanged first line.
    const newLines = after.text.split(/\r?\n/).filter((line) => !before.text.split(/\r?\n/).includes(line)).join("\n");
    if (nativeCliConfirmedModel(after.text, [input.model], input.runtimeId) === input.model.id) {
      if ((input.runtimeId === 'cli:omp' || input.runtimeId === 'cli:gemini') && input.effort && input.effort !== 'none') {
        const confirmedEffort = nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model);
        if (confirmedEffort === input.effort || (!confirmedEffort && !/unknown|invalid|error/i.test(after.text) && !/╰─[^\n]*\/switch/i.test(after.text))) return;
      } else {
        return;
      }
    }
    if (/models matching.*\(no matches\)/i.test(newLines)) {
      await input.assertCurrent();
      await input.write("\u001b");
      throw new SpaceConflictError("This model is not available in the CLI's current model menu. Choose another model.");
    }
    if (/can't be selected|only Auto mode is available/i.test(newLines)) {
      throw new SpaceConflictError("This CLI account does not allow the selected model. Choose Auto or check your plan.");
    }
    if (/unknown command|unrecognized command|invalid (?:slash command|model)|model (?:not found|unavailable)|error:\s*unknown model/i.test(newLines)) {
      throw new SpaceConflictError("The CLI rejected the model selection. Check its model menu.");
    }
    if (input.runtimeId === 'cli:kimi' && /Select a model/.test(after.text)) {
      if (!kimiFiltered) {
        await input.assertCurrent(); await input.write(input.model.displayName); kimiFiltered = true; continue;
      }
      // A single result for the complete advertised name is unambiguous even
      // when the native menu truncates that result's label at small widths.
      if (/^\s*1 \/ \d+\s*$/m.test(after.text)) {
        await input.assertCurrent(); await input.write('\u001bs'); continue;
      }
    }
    // Some CLIs open their native picker even when /model has an argument.
    // Navigate only an observed model menu, and still require its acknowledgement.
    if (after.revision !== lastMenuRevision && /select (?:a )?model|choose (?:a )?model|models matching/i.test(after.text)) {
      const highlighted = after.text.split(/\r?\n/).find((line) => /^\s*[❯›>●→]/u.test(line));
      const labels = [input.model.id, input.model.displayName];
      if (highlighted && labels.some((label) => after.text.includes(label))) {
        const highlightedLabel = highlighted.replace(/^\s*[❯›>●→]\s*/u, "").trim().split(/\s{2,}|\s+←/)[0];
        const selected = labels.includes(highlightedLabel!);
        lastMenuRevision = after.revision;
        await input.assertCurrent();
        await input.write(selected ? (input.runtimeId === "cli:kimi" ? "\u001bs" : "\r") : "\u001b[B");
      }
    }
    if (input.runtimeId === "cli:deepseek" && !submittedCompletion && after.text.split(/\r?\n/).some((line) =>
      line.replace(/^\s*❯\s*/u, "").trim() === command && /^\s*❯/u.test(line))) {
      // Reasonix's first Enter completes a slash command; submit only the exact
      // requested command, never a different model suggested by autocomplete.
      submittedCompletion = true;
      await input.assertCurrent();
      await input.write("\r");
    }
    if (input.runtimeId === "cli:omp" && /╰─[^\n]*\/switch/i.test(after.text)) {
      await input.assertCurrent();
      await input.write("\r");
    }
  }
  throw new SpaceConflictError("The CLI has not confirmed the model change. Check its terminal for a selection or confirmation dialog.");
}


export async function switchNativeCliModel(input: Parameters<typeof applyNativeCliModel>[0]): Promise<void> {
  try { await applyNativeCliModel(input); }
  catch (error) { try { await cleanupNativeSettingsMenu(input); } catch {} throw error; }
}

export async function switchNativeCliReasoning(input: Parameters<typeof applyNativeCliReasoning>[0]): Promise<void> {
  try { await applyNativeCliReasoning(input); }
  catch (error) { try { await cleanupNativeSettingsMenu(input); } catch {} throw error; }
}
