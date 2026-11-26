import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../auth/password.ts';

/**
 * Usage: hash-password [--env]
 * Prints an Argon2id hash for LOOKOUT_PASSWORD_HASH. With --env it prints a whole .env line
 * instead, with each $ written as $$ as Compose needs.
 */
const asEnvLine = process.argv.includes('--env');

/** Prompts for a line of input without echoing what is typed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (!muted) process.stderr.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Cancelled'));
    });
  });
}

try {
  const password = await promptHidden('Password: ');
  if (password.length < 8) {
    console.error('Use a password of at least 8 characters.');
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const again = await promptHidden('Confirm password: ');
    if (again !== password) {
      console.error('The passwords do not match.');
      process.exit(1);
    }
  }
  const hash = await hashPassword(password);
  // Only the hash (or the .env line) goes to stdout, so it can be piped or captured.
  if (asEnvLine) {
    console.log(`LOOKOUT_PASSWORD_HASH=${hash.replaceAll('$', '$$$$')}`);
    console.error('\nAdd this line to the .env file next to compose.yaml.');
  } else {
    console.log(hash);
    console.error(
      '\nSet this as LOOKOUT_PASSWORD_HASH. In a Compose file or .env used by Compose, write each $ as $$.',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
