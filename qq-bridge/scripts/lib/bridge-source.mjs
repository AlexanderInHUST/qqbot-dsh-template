// 桥接的源码：src/bridge.js 加上从它 main() 里拆出去的 src/app/*.js（2026-10-24 拆的）。
// 按源码文本做静态检查的测试用它，不然拆出去的路由、默认值、函数都找不到。
import fs from 'node:fs';
import path from 'node:path';

export function bridgeSourceFiles(root) {
  const appDir = path.join(root, 'src', 'app');
  const app = fs.existsSync(appDir)
    ? fs.readdirSync(appDir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(appDir, f))
    : [];
  return [path.join(root, 'src', 'bridge.js'), ...app];
}

export function readBridgeSource(root) {
  return bridgeSourceFiles(root).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
