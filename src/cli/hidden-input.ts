import { emitKeypressEvents } from 'node:readline';

type HiddenInputStream = NodeJS.ReadStream;
type HiddenOutputStream = NodeJS.WriteStream;

export async function promptHidden(
  prompt: string,
  input: HiddenInputStream = process.stdin,
  output: HiddenOutputStream = process.stdout
): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('秘密情報の入力には対話型Terminalが必要です');
  }

  output.write(prompt);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('入力を中止しました'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text) value += text;
    };
    input.on('keypress', onKeypress);
  });
}
