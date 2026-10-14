// Terminal prompts; `hidden` suppresses echo for passwords.
import { createInterface } from 'node:readline';

export function ask(question: string, { hidden = false } = {}): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
        // Swallow everything readline would echo after the question itself.
        (rl as any)._writeToOutput = (s: string) => {
            if (s.startsWith(question)) process.stdout.write(question);
        };
    }
    return new Promise((resolve) =>
        rl.question(question, (answer) => {
            rl.close();
            if (hidden) process.stdout.write('\n');
            resolve(answer.trim());
        }),
    );
}
