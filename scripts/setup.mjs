// npm install 뒤에 실행: ffmpeg.wasm 파일을 웹(public/vendor)과 앱(android 에셋)에 복사한다.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const mod = (p) => join(root, 'node_modules', '@ffmpeg', p);

function copyJs(from, to) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) if (f.endsWith('.js')) cpSync(join(from, f), join(to, f));
}

copyJs(mod('ffmpeg/dist/esm'), join(root, 'public/vendor/ffmpeg'));
copyJs(mod('util/dist/esm'), join(root, 'public/vendor/util'));

const core = join(root, 'android/app/src/main/core-assets/core');
mkdirSync(core, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) cpSync(mod(`core/dist/esm/${f}`), join(core, f));

console.log('ffmpeg 파일 복사 완료');
