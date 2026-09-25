// ── Arg Parser ──────────────────────────────────────────────────

export const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }

  result._command = positional[0] ?? '';
  result._arg1 = positional[1] ?? '';

  return result;
};

/**
 * The CLI's flags, and for `send` the words after it. `send` takes everything
 * after it as the target and the message, verbatim: its flags come from the
 * part before it only, so a `--base-url` word in a message never redirects the
 * API key and a `--version` never swallows the send.
 */
export const parseCliArgv = (argv: string[]): { args: Record<string, string | boolean>; sendArgv: string[] } => {
  const at = parseArgs(argv)._command === 'send' ? argv.indexOf('send', 2) : -1;
  return at < 0
    ? { args: parseArgs(argv), sendArgv: [] }
    : { args: parseArgs(argv.slice(0, at + 1)), sendArgv: argv.slice(at + 1) };
};
