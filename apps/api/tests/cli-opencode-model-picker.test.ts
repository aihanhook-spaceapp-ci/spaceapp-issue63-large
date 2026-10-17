import { describe, expect, it } from 'vitest';
import { advertisedOpenCodeModel, OpenCodeNativeInputNotReadyError, openCodeCurrentSelection, openCodeCurrentSelectionWithSource, openCodeMenuRows, openCodeTuiSelection, switchOpenCodeTuiSettings } from '../src/cli-opencode-model-picker.js';

const model = {
  id: 'opencode/ling-3.0-flash-fin-free', displayName: 'Ling 3.0 Flash Fin Free', description: 'OpenCode Zen',
  isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['default','low','medium','high'],
  reasoningOptions: ['default','low','medium','high'].map(reasoningEffort => ({reasoningEffort}))
};

describe('OpenCode native selection', () => {
  it('reads the full model and reasoning from the independently wrapped narrow footer columns', () => {
    const screen = ['  ┃  Bu ·Ling 3.0   O·m', '  ┃  il  Flash Fin  p e', '  ┃  d   Free       e d',
      '  ┃                 n i', '  ┃                 C u', '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'].join('\n');
    expect(openCodeTuiSelection(screen, [model])).toEqual({modelId:model.id,reasoningEffort:'medium'});
    expect(openCodeTuiSelection(screen, [model,{...model,id:'another/model'}])).toBeNull();
  });

  it('reads an unset native variant as Default and ignores a model menu without the composer', () => {
    expect(openCodeTuiSelection('  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen\n  ╹▀▀', [model])).toEqual({modelId:model.id,reasoningEffort:'default'});
    expect(openCodeTuiSelection('Select model\n\nSearch\n\n● Ling 3.0 Flash Fin Free OpenCode Zen', [model])).toBeNull();
    expect(openCodeTuiSelection('  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen · high       /etc\n  ╹▀▀', [model])).toEqual({modelId:model.id,reasoningEffort:'high'});
  });

  it('extracts current variants from a narrow dialog whose heading wraps around Escape', () => {
    expect(openCodeMenuRows('  Select     esc\n  variant\n\n  Search\n\n  Default\n  low\n● medium\n  high\n\n', /Select(?:\s+esc)?\s+variant/))
      .toEqual(['Default','low','● medium','high']);
  });

  it('prefers the picker-applied server model over a stale native footer', () => {
    const server = { modelId: 'legacy/kimi-k3', reasoningEffort: 'default' };
    const staleNative = { modelId: 'opencode/deepseek-v4-flash-free', reasoningEffort: 'default' };
    expect(openCodeCurrentSelection('legacy/kimi-k3', server, staleNative)).toEqual(server);
    expect(openCodeCurrentSelection('legacy/kimi-k3', server, null)).toEqual(server);
    // Genuine native drift (server moved on too) still wins.
    expect(openCodeCurrentSelection('legacy/kimi-k3', staleNative, staleNative)).toEqual(staleNative);
    // Without a picker-applied model the native footer stays authoritative.
    expect(openCodeCurrentSelection(null, server, staleNative)).toEqual(staleNative);
    expect(openCodeCurrentSelection(null, server, null)).toEqual(server);
    expect(openCodeCurrentSelection(null, null, null)).toBeNull();
  });

  it('falls back to persisted session model on fresh panes like Codex does', () => {
    const catalog = [model, { ...model, id: 'opencode/muse-spark-1.3-free', displayName: 'Muse Spark 1.3 Free', defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: ['default', 'xhigh'] }];
    // Fresh OpenCode pane: TUI unreadable, server has no current yet.
    expect(openCodeCurrentSelection('opencode/muse-spark-1.3-free', null, null, catalog, 'xhigh'))
      .toEqual({ modelId: 'opencode/muse-spark-1.3-free', reasoningEffort: 'xhigh' });
    // Invalid persisted effort falls back to model default.
    expect(openCodeCurrentSelection('opencode/muse-spark-1.3-free', null, null, catalog, 'ultra'))
      .toEqual({ modelId: 'opencode/muse-spark-1.3-free', reasoningEffort: 'xhigh' });
    // Unadvertised persisted model stays null instead of inventing selection.
    expect(openCodeCurrentSelection('unknown/model', null, null, catalog, 'xhigh')).toBeNull();
  });

  it('resolves the bare native alias a freshly opened pane persists', () => {
    const bigPickle = { ...model, id: 'opencode/big-pickle', displayName: 'Big Pickle',
      defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default', 'low', 'medium'] };
    const catalog = [model, bigPickle];
    // A fresh OpenCode pane persists the runtime descriptor default bare
    // ('big-pickle') while the catalog advertises 'opencode/big-pickle'.
    expect(advertisedOpenCodeModel('big-pickle', catalog)).toEqual(bigPickle);
    expect(openCodeCurrentSelection('big-pickle', null, null, catalog, 'medium'))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'medium' });
    // An unadvertised persisted effort falls back to the model default.
    expect(openCodeCurrentSelection('big-pickle', null, null, catalog, 'ultra'))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'default' });
    // The server's own current model still wins over the alias default.
    expect(openCodeCurrentSelection('big-pickle', { modelId: 'opencode/big-pickle', reasoningEffort: 'low' }, null, catalog))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'low' });
    // An ambiguous alias is never resolved into a selection.
    const ambiguous = [bigPickle, { ...bigPickle, id: 'legacy/big-pickle' }];
    expect(advertisedOpenCodeModel('big-pickle', ambiguous)).toBeNull();
    expect(openCodeCurrentSelection('big-pickle', null, null, ambiguous)).toBeNull();
    // Exact composite ids keep winning and unknown slashed ids stay unmatched.
    expect(advertisedOpenCodeModel('opencode/big-pickle', catalog)).toEqual(bigPickle);
    expect(advertisedOpenCodeModel('other/big-pickle', catalog)).toBeNull();
  });

  it('reports an unreadable composer without sending any keys', async () => {
    const writes: string[] = [];
    const error = await switchOpenCodeTuiSettings({ model, effort:'high',wait:async()=>{},assertCurrent:async()=>{},models:[model],
      read:async()=>({text:'booting…',revision:0}),write:async keys=>{ writes.push(keys); }
    }).catch(error => error);
    expect(error).toBeInstanceOf(OpenCodeNativeInputNotReadyError);
    expect(writes).toEqual([]);
  });

  it.each(['', 'ctrl+p', 'ctrl+p comm'])('switches from an indented composer with clipped hints: %s', async (hint) => {
    const narrowModel = { ...model, reasoningOptions: [], supportedReasoningEfforts: ['default'] };
    const footer = ['  ┃ Build', '  ╹▀▀▀▀▀▀▀▀▀▀▀▀', hint].join('\n');
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({ model: narrowModel, effort: 'default', models: [narrowModel],
      wait: async () => {}, assertCurrent: async () => {},
      read: async () => ({ text: screen, revision: writes.length }),
      write: async keys => {
        writes.push(keys);
        if (keys === 'm' || keys.startsWith(model.displayName)) {
          screen = `Select model\n\nSearch\n\n${model.displayName}\n\nActions`;
        }
        if (keys === '\u001b') screen = footer;
      }
    });
    expect(writes).toContain('\u0018');
    expect(writes).toContain('\r');
  });

  it('does not send keys to an unfinished composer with no rail or keyboard hints', async () => {
    const writes: string[] = [];
    await expect(switchOpenCodeTuiSettings({ model, effort: 'high', models: [model],
      wait: async () => {}, assertCurrent: async () => {},
      read: async () => ({ text: '  ┃ Starting…', revision: 0 }),
      write: async keys => { writes.push(keys); }
    })).rejects.toBeInstanceOf(OpenCodeNativeInputNotReadyError);
    expect(writes).toEqual([]);
  });

  it('reads a separator-less narrow composer against advertised display names', () => {
    const spark = { ...model, id: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', description: 'OpenCode Zen',
      defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default', 'xhigh'] };
    const qwen = { ...model, id: 'opencode-go/qwen3.7-max', displayName: 'Qwen3.7 Max', description: 'OpenCode Go' };
    const screen = [
      '  ┃  Build   Muse Spark 1.3 Free OpenCode Zen   xhigh',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join('\n');
    expect(openCodeTuiSelection(screen, [spark, qwen])).toEqual({ modelId: spark.id, reasoningEffort: 'xhigh' });
    expect(openCodeTuiSelection(screen, [qwen])).toBeNull();
    expect(openCodeTuiSelection('  ┃  Build   Qwen3.7 Max OpenCode Go', [spark, qwen])).toBeNull();
  });

  it('drives a separator-less narrow composer end to end', async () => {
    const narrowModel = { id: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', description: 'OpenCode Zen',
      isDefault: false, defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default'] };
    const footer = [
      '  ┃  Build   Muse Spark 1.3 Free OpenCode Zen',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join('\n');
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({ model: narrowModel, effort: 'default', wait: async()=>{}, assertCurrent: async()=>{},models:[narrowModel],
      read: async()=>({text:screen,revision:writes.length}), write: async keys=>{
        writes.push(keys);
        if(keys==='m') screen='Select model\n\nSearch\n\nMuse Spark 1.3 Free OpenCode Zen\n\nActions';
        if(keys.startsWith('Muse')) screen='Select model\n\nMuse\n\n• Muse Spark 1.3 Free OpenCode Zen\n\nActions';
        if(keys==='\u001b') screen=footer;
      }
    });
    expect(writes).toContain('\u0018');
    expect(writes).toContain('m');
    expect(writes.at(-1)).toBe('\u001b');
  });

  it('selects wrapped narrow menu fragments by unique advertised name', async () => {
    const spark = { id: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', description: 'OpenCode Zen',
      isDefault: false, defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default'] };
    const other = { ...spark, id: 'opencode/big-pickle', displayName: 'Big Pickle' };
    const footer = [
      '  ┃  Build   Muse Spark 1.3 Free OpenCode Zen',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join('\n');
    const fragments = 'Select model\n\nSearch\n\n• Mus OpenCode Zen\n Muse Spa\n 3 Free';
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({ model: spark, effort: 'default', wait: async()=>{}, assertCurrent: async()=>{}, models: [spark, other],
      read: async()=>({text:screen,revision:writes.length}), write: async keys=>{
        writes.push(keys);
        if(keys==='m'||keys.startsWith('Muse')) screen=fragments;
        if(keys==='\r') screen=fragments.replace('• Mus', '• Mus');
        if(keys==='\u001b') screen=footer;
      }
    });
    expect(writes).toContain('\r');
    expect(writes).not.toContain('\u001b[B');
    expect(writes.at(-1)).toBe('\u001b');

    // Fragments naming two advertised models stay rejected.
    screen = footer;
    const writes2: string[] = [];
    await expect(switchOpenCodeTuiSettings({ model: spark, effort: 'default', wait: async()=>{}, assertCurrent: async()=>{}, models: [spark, other],
      read: async()=>({text:screen,revision:writes2.length}), write: async keys=>{
        writes2.push(keys);
        if(keys==='m'||keys.startsWith('Muse')) screen=`${fragments}\n Big Pickle`;
        if(keys==='\u001b') screen=footer;
      }
    })).rejects.toThrow('could not distinguish');
  });

  it('never submits a model when the native filtered menu has no result', async () => {
    let screen = '  ┃ Build · Existing Model\nctrl+p commands';
    const writes: string[] = [];
    await expect(switchOpenCodeTuiSettings({ model, effort:'high',wait:async()=>{},assertCurrent:async()=>{},models:[model],
      read:async()=>({text:screen,revision:writes.length}),write:async keys=>{
        writes.push(keys);
        if(keys==='m') screen='Select model\n\nSearch\n\nExisting Model\n\nActions';
        if(keys.startsWith('Ling'))screen='Select model\n\nLing\n\nNo results found\n\nActions';
        if(keys==='\u001b')screen='  ┃ Build · Existing Model';
      }
    })).rejects.toThrow('did not find');
    expect(writes).not.toContain('\r');
    expect(writes).not.toContain('\u0015');
    expect(writes.at(-1)).toBe('\u001b');
  });

  it('switches only the variant when the requested model is already active', async () => {
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const ESC = String.fromCharCode(27);
    const CTRL_X = String.fromCharCode(24);
    const CTRL_P = String.fromCharCode(16);
    const footer = [
      '  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen · low       /etc',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    const commandsMenu = ['Commands', '', 'Search', '', 'Switch model variant', '', 'Actions'].join(LF);
    const variantMenu = ['Select variant', '', 'Search', '', 'Default', 'low', 'medium', 'high', '', 'Actions'].join(LF);
    const filteredVariant = ['Select variant', '', 'high', '', 'high', '', 'Actions'].join(LF);
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({ model, effort: 'high', skipModelStep: true, wait: async () => {}, assertCurrent: async () => {}, models: [model],
      read: async () => ({ text: screen, revision: writes.length }), write: async keys => {
        writes.push(keys);
        if (keys === CTRL_P) screen = commandsMenu;
        else if (keys === 'high') screen = filteredVariant;
        else if (keys === CR) screen = screen === filteredVariant ? footer : variantMenu;
        else if (keys === ESC) screen = footer;
      }
    });
    expect(writes).toContain(CTRL_P);
    expect(writes).toContain('Switch model variant');
    expect(writes).toContain(CR);
    expect(writes).not.toContain(CTRL_X);
    expect(writes.every(entry => entry.indexOf('Ling 3.0') < 0)).toBe(true);
  });

  it('sends no menu keys for a reasoning-only change without variants', async () => {
    const LF = String.fromCharCode(10);
    const narrowModel = { id: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', description: 'OpenCode Zen',
      isDefault: false, defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default'] };
    const footer = [
      '  ┃  Build   Muse Spark 1.3 Free OpenCode Zen',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({ model: narrowModel, effort: 'default', skipModelStep: true, wait: async () => {}, assertCurrent: async () => {}, models: [narrowModel],
      read: async () => ({ text: footer, revision: writes.length }), write: async keys => { writes.push(keys); }
    });
    expect(writes).toEqual([]);
  });

  it('selects variant directly without command palette when model selection auto-opens variant dialog', async () => {
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const ESC = String.fromCharCode(27);
    const CTRL_X = String.fromCharCode(24);
    const CTRL_P = String.fromCharCode(16);
    const footer = [
      '  ┃ Build · Muse Spark 1.3 Free OpenCode Zen · low       /etc',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    const modelDialog = ['Select model', '', 'Search', '', 'Ling 3.0 Flash Fin Free OpenCode Zen', '', 'Actions'].join(LF);
    const variantDialog = ['Select variant', '', 'Search', '', 'Default', 'low', 'medium', 'high', '', 'Actions'].join(LF);
    const filteredVariant = ['Select variant', '', 'high', '', 'high', '', 'Actions'].join(LF);
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({
      model, effort: 'high', wait: async () => {}, assertCurrent: async () => {}, models: [model],
      read: async () => ({ text: screen, revision: writes.length }),
      write: async keys => {
        writes.push(keys);
        if (keys === 'm') screen = modelDialog;
        else if (keys === CR && screen === modelDialog) screen = variantDialog; // Auto-transition to variant dialog
        else if (keys === 'high') screen = filteredVariant;
        else if (keys === CR && screen === filteredVariant) screen = footer;
        else if (keys === ESC) screen = footer;
      }
    });
    expect(writes).toContain(CTRL_X);
    expect(writes).toContain('m');
    expect(writes).not.toContain(CTRL_P); // Bypasses Command palette since variant dialog was already open!
    expect(writes).toContain('high');
  });

  it('fails with clear error when Switch model variant has no matching commands', async () => {
    const LF = String.fromCharCode(10);
    const CTRL_P = String.fromCharCode(16);
    const footer = [
      '  ┃ Build · Model Without Variants · default       /etc',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    const commandsMenu = ['Commands', '', 'Search', '', 'Select model', 'Agent cycle', '', 'Actions'].join(LF);
    const emptyCommands = ['Commands', '', 'Switch model variant', '', 'No matching commands', '', 'Actions'].join(LF);
    let screen = footer;
    const writes: string[] = [];
    await expect(switchOpenCodeTuiSettings({
      model, effort: 'high', skipModelStep: true, wait: async () => {}, assertCurrent: async () => {}, models: [model],
      read: async () => ({ text: screen, revision: writes.length }),
      write: async keys => {
        writes.push(keys);
        if (keys === CTRL_P) screen = commandsMenu;
        else if (keys === 'Switch model variant') screen = emptyCommands;
      }
    })).rejects.toThrow('The active OpenCode model does not support reasoning variants.');
  });

  it('skips variant commands menu when changing model with default effort', async () => {
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const ESC = String.fromCharCode(27);
    const CTRL_X = String.fromCharCode(24);
    const CTRL_P = String.fromCharCode(16);
    const footer = [
      '  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen · low       /etc',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    const modelDialog = ['Select model', '', 'Search', '', 'Ling 3.0 Flash Fin Free OpenCode Zen', '', 'Actions'].join(LF);
    let screen = footer;
    const writes: string[] = [];
    await switchOpenCodeTuiSettings({
      model, effort: 'default', wait: async () => {}, assertCurrent: async () => {}, models: [model],
      read: async () => ({ text: screen, revision: writes.length }),
      write: async keys => {
        writes.push(keys);
        if (keys === 'm') screen = modelDialog;
        else if (keys === CR && screen === modelDialog) screen = footer;
        else if (keys === ESC) screen = footer;
      }
    });
    expect(writes).toContain(CTRL_X);
    expect(writes).toContain('m');
    expect(writes).toContain(CR);
    expect(writes).not.toContain(CTRL_P);
    expect(writes).not.toContain('Switch model variant');
  });

  it('throws OpenCodeNativeInputNotReadyError when command palette does not open for variant change', async () => {
    const LF = String.fromCharCode(10);
    const CTRL_P = String.fromCharCode(16);
    const footer = [
      '  ┃ Build · Model With Variants · low       /etc',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join(LF);
    let screen = footer;
    const writes: string[] = [];
    await expect(switchOpenCodeTuiSettings({
      model, effort: 'high', skipModelStep: true, wait: async () => {}, assertCurrent: async () => {}, models: [model],
      read: async () => ({ text: screen, revision: writes.length }),
      write: async keys => {
        writes.push(keys);
        // Commands palette never opens (e.g. key dropped while modal closing)
      }
    })).rejects.toBeInstanceOf(OpenCodeNativeInputNotReadyError);
    expect(writes).toContain(CTRL_P);
  });
});

describe('OpenCode current model provenance', () => {
  const spark = { ...model, id: 'opencode/muse-spark-1.3-free', displayName: 'Muse Spark 1.3 Free',
    description: 'OpenCode Zen', defaultReasoningEffort: 'minimal',
    supportedReasoningEfforts: ['default', 'minimal', 'xhigh'] };
  const bigPickle = { ...model, id: 'opencode/big-pickle', displayName: 'Big Pickle',
    description: 'OpenCode Zen', defaultReasoningEffort: 'default',
    supportedReasoningEfforts: ['default', 'low', 'medium'] };
  const catalog = [spark, bigPickle];
  // Operator-reported footer of a freshly opened pane (2026-09-10): the CLI runs
  // Muse Spark 1.3 Free while the pane's persisted session default is big-pickle.
  const footer = [
    '  ┃ Build · Muse Spark 1.3 Free OpenCode Zen · minimal                  /etc',
    '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    '             esc interrupt   272.2K (26%)  ctrl+p commands'
  ].join('\n');

  it('reads the model and reasoning a fresh pane shows in its own footer', () => {
    expect(openCodeTuiSelection(footer, catalog)).toEqual({ modelId: spark.id, reasoningEffort: 'minimal' });
  });

  it('marks the persisted session default as provisional instead of the CLI model', () => {
    // Neither the TUI nor the OpenCode server reports a model yet: the reading is
    // the persisted descriptor default and must stay marked as provisional so the
    // pane keeps re-reading instead of showing 'Big Pickle' indefinitely.
    expect(openCodeCurrentSelectionWithSource('big-pickle', null, null, catalog, null))
      .toEqual({ current: { modelId: bigPickle.id, reasoningEffort: 'default' }, source: 'session-default' });
    // The native footer is the CLI's own state: it settles the picker.
    expect(openCodeCurrentSelectionWithSource('big-pickle', null, { modelId: spark.id, reasoningEffort: 'minimal' }, catalog))
      .toEqual({ current: { modelId: spark.id, reasoningEffort: 'minimal' }, source: 'native' });
    // The runtime server's model settles it too, even before the footer is readable.
    expect(openCodeCurrentSelectionWithSource('big-pickle', { modelId: spark.id, reasoningEffort: 'minimal' }, null, catalog))
      .toEqual({ current: { modelId: spark.id, reasoningEffort: 'minimal' }, source: 'server' });
    // A picker-applied model the server agrees with stays a server reading.
    expect(openCodeCurrentSelectionWithSource('big-pickle', { modelId: bigPickle.id, reasoningEffort: 'low' }, null, catalog))
      .toEqual({ current: { modelId: bigPickle.id, reasoningEffort: 'low' }, source: 'server' });
    // Nothing confirmed and no advertised default: no selection is invented.
    expect(openCodeCurrentSelectionWithSource('unknown/model', null, null, catalog))
      .toEqual({ current: null, source: null });
  });

  it('keeps the plain selection API returning the same reading', () => {
    expect(openCodeCurrentSelection('big-pickle', null, { modelId: spark.id, reasoningEffort: 'minimal' }, catalog))
      .toEqual({ modelId: spark.id, reasoningEffort: 'minimal' });
  });
});
