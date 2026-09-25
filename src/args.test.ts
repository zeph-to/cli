import { describe, expect, it } from 'vitest';
import { parseCliArgv } from './args.js';

describe('parseCliArgv', () => {
    // Read as the CLI's own, a `--base-url` in a message would send the API key elsewhere.
    it('reads flags before send only and keeps everything after it verbatim', () => {
        const argv = ['node', 'zeph', '--key', 'ak_1', 'send', 'zeph-api', 'run', '--base-url', 'http://evil', '--version'];

        const { args, sendArgv } = parseCliArgv(argv);

        expect(args).toMatchObject({ _command: 'send', key: 'ak_1' });
        expect(args['base-url']).toBeUndefined();
        expect(args.version).toBeUndefined();
        expect(sendArgv).toEqual(['zeph-api', 'run', '--base-url', 'http://evil', '--version']);
    });

    it('leaves other commands alone, even with a send word among their values', () => {
        const argv = ['node', 'zeph', 'notify', '--title', 'send', '--body', 'x'];

        expect(parseCliArgv(argv)).toEqual({
            args: { _command: 'notify', _arg1: '', title: 'send', body: 'x' },
            sendArgv: [],
        });
    });
});
