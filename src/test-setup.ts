/**
 * Point every test at a throwaway home before any of them runs.
 *
 * The daemon keeps real state under `$HOME` and `$XDG_STATE_HOME` — the config,
 * the remote marker, the registry of sessions this machine has run. Tests reach
 * that state without meaning to: a test that only wanted to check a lease calls
 * into the inventory sweep, and the sweep writes down what it saw. With fake
 * tmux answering, what it wrote down was fiction, in the developer's own
 * registry, on the machine they use.
 *
 * That already happened. Four invented sessions from the lease test's fake tmux
 * ended up in a real registry and then on a real phone, each offering to start
 * an agent in a directory that never existed.
 *
 * Eleven test files had guarded themselves individually. That is the wrong
 * shape for this: it is a rule every future test has to remember, and the ones
 * that forget do not fail — they quietly write somewhere real. Setting it here
 * makes the safe thing the default. A file that still wants its own directory
 * assigns one in its module body, which runs after this and wins.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sandbox = mkdtempSync(join(tmpdir(), 'zeph-test-home-'));

process.env.HOME = sandbox;
process.env.XDG_STATE_HOME = join(sandbox, 'state');
process.env.XDG_CONFIG_HOME = join(sandbox, 'config');
