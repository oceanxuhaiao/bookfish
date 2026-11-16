import { Library } from '../../src/library.ts';

const dir = process.argv[2];
const archive = process.argv[3];
const stageToKill = process.env.KILL_STAGE ?? 'after-commit';
const mode = process.env.KILL_MODE ?? 'exit';
if (!dir || !archive) process.exit(2);
const lib = new Library({ dataDir: dir, storyMemoryEnabled: true });
lib.open();
lib.restoreArchive(archive, {
  onStage: stage => {
    if (stage !== stageToKill) return;
    if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
    process.exit(23);
  },
});
lib.close();
