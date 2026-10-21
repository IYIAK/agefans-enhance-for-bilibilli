# Danmaku Enhance 官网

脚本本体在仓库根目录（`../src` 编译成 `../dist/index.user.js`），这里是它的官网：一页介绍 + 一页更新日志。纯静态，零外部请求，构建产物直接交给 Cloudflare Workers 静态资源托管。

## 结构

```
site/
├── build.mjs             # 构建脚本：先校验，后写盘
├── wrangler.toml.example # 部署配置模板（真实配置本地保留，不入库）
├── data/changelog.mjs    # 更新日志数据（唯一需要手改的地方）
└── src/style.css         # 全部样式，构建时内联进 HTML
```

仓库里不含任何域名。第一次部署前把模板复制成本地配置并填上自己的域名：

```bash
cp wrangler.toml.example wrangler.toml   # wrangler.toml 已在 .gitignore 里
```

`wrangler.toml` 属于账号与域名信息，只留在本地，不随代码同步。

`dist/` 是构建产物，不入库。构建时如果 `../dist/index.user.js` 存在，会一起拷进 `dist/`，让「安装脚本」按钮指向同域。

## 构建

```bash
node build.mjs
```

构建脚本按约定守住四件事，任一条不过就直接 `exit 1`、不写产物：

1. **先校验后写盘** —— 全部检查通过才删 `dist` 重建。
2. **不许残留占位符** —— 扫描 `__STYLE__`、`{{`。
3. **断言关键内容** —— 站点名、版本号、更新日志入口、每个版本的版本号必须逐字出现。
4. **首屏零外链** —— 扫描 `src`/`href`/`@import`/`url(http…)`，只放行页脚那两个给人点的 GitHub 超链接。

改文案就改 `build.mjs` 里的数组（`features` / `sources` / `steps` / `faqs`），改版本记录就改 `data/changelog.mjs`。

## 部署

```bash
node build.mjs
node ../node_modules/wrangler/bin/wrangler.js deploy --config wrangler.toml
```

`wrangler.toml` 里 `routes` 必须写在 `[assets]` **之前** —— 写在后面会被当成它的字段并静默丢弃，域名绑不上还不报错。

## 验证线上

```bash
# 线上字节数必须等于本地 dist/index.html 的字节数
curl -s -H "Cache-Control: no-cache" -o /dev/null \
     -w "http=%{http_code} size=%{size_download}\n" \
     "https://<你的域名>/?cb=$(date +%s)"
ls -l dist/index.html
```

CDN 有惯性期，字节数对不上就是拿到旧副本，别急着判定部署失败。核对时开新标签页。

## 本地预览

无头 Edge 直接截图即可（不用起服务器）：

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir=/tmp/edge-shot --window-size=1280,2800 \
  --virtual-time-budget=6000 --screenshot=/tmp/home.png \
  "file:///C:/Users/kaiyi/Desktop/code/bilibili-import-danmu/repo/site/dist/index.html"
```

`--window-size` 有约 510px 的最小宽度，测窄屏要套一层 iframe（宽 390px），不能直接调小窗口。
