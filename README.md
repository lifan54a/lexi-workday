# Lexi's workday · 排期台

一个用于记录每日工作、安排项目工期和自动汇总周报的个人工作台。把任务、耗时、进度和截止日期放在一起，方便查看当天待办和整月安排。

**在线使用：[work.yoube.cloud](https://work.yoube.cloud/)**（需要访问密码）

## 功能

- **每日记录**：新增、编辑、删除任务，记录项目名称、紧急程度、耗时、进度、开始日期、持续天数、Deadline、备注和需求文档链接。
- **待办延续**：未完成任务会继续出现在后续日期的待办中，按紧急程度和截止日期排序；当天可查看任务数、到期任务数和平均进度。
- **月度排期**：以日历和跨日任务条展示工期，点击日期定位当天任务，悬停查看任务详情。
- **周报生成**：按周统计工时、项目、平均进度和重点事项，生成可复制、可打印的周报文本；支持填写汇报人。
- **云端同步**：保存工作记录，并使用浏览器本地缓存支持断网期间继续记录；恢复连接或重新进入页面时尝试同步。
- **界面体验**：明暗主题切换、响应式布局、首页像素背景与界面动效。

## 日常使用

1. 输入访问密码进入工作台，在「每日记录」选择日期并添加任务。
2. 更新耗时、进度和备注，用「月度视图」检查跨日工期与截止安排。
3. 在「周报生成」切换工作周，填写汇报人后复制或打印汇总结果。

任务编辑会先更新本机缓存，再保存到云端。出现同步失败提示时可保留当前页面，应用会在恢复连接后重试；若提示本机存储也不可用，应先保留页面中的记录。

## 项目结构

```text
public/legacy/                 共享的任务界面、样式和浏览器同步逻辑
app/                          React 页面、共享界面挂载及 Cloudflare 任务 API
app/components/               首页背景与界面组件
worker/index.ts               Cloudflare 登录验证及请求入口
edgeone/
  build.mjs                   将共享界面和图标复制为 EdgeOne 静态产物
  cloud-functions/            任务存储 API、登录及登录限流
  edge-functions/api/         旧 KV 数据的只读迁移接口
  middleware.js               站点访问验证
  README.md                   EdgeOne 存储、同步及部署维护说明
tests/                        同步、存储、迁移、认证和页面渲染测试
.github/workflows/            Cloudflare 自动部署工作流
```

浏览器中的任务操作主要位于 [`public/legacy/app.js`](public/legacy/app.js)。EdgeOne 构建直接使用这套界面；React 页面通过 [`LegacyHome.tsx`](app/components/LegacyHome.tsx) 挂载同一份界面与任务逻辑。

## 本地开发

需要 Node.js **22.13.0 或更新版本**。

```bash
npm install
```

本地完整应用走 vinext / Cloudflare 开发入口。先在仓库根目录创建 `.dev.vars`，设置本地访问密码和会话签名密钥：

```dotenv
WEB_PASSWORD=replace-with-your-local-password
SESSION_SECRET=replace-with-a-long-random-secret
```

这些文件已加入 Git 忽略规则。Cloudflare 开发环境使用 `DB` D1 绑定模拟本地数据库，配置见 [`vite.config.ts`](vite.config.ts)。

macOS / Linux：

```bash
npm run dev
```

Windows PowerShell：

```powershell
$env:WRANGLER_LOG_PATH = '.wrangler/wrangler.log'
npx vinext dev
```

打开终端输出的本地地址，输入 `.dev.vars` 中设置的密码。

## 构建与检查

```bash
# 自动化测试
node --test tests/*.test.mjs

# EdgeOne 静态资源构建，输出 edgeone/dist/
node edgeone/build.mjs
```

vinext 生产构建使用 `npm run build`。Windows PowerShell 使用：

```powershell
$env:WRANGLER_LOG_PATH = '.wrangler/wrangler.log'
npx vinext build
```

测试覆盖并发保存、离线恢复、保存期间编辑、删除记录保留、清理版本拦截、旧 KV 迁移、Blob 条件写入、登录验证和页面渲染等场景。

## 部署

### EdgeOne：当前生产站点

当前生产域名为 [work.yoube.cloud](https://work.yoube.cloud/)，关联本仓库的 `main` 分支。项目根目录为 `edgeone`，构建命令为 `npm run build`，静态输出目录为 `dist`。

- 设置 `WEB_PASSWORD` 和 `SESSION_SECRET`，用于访问密码验证和会话签名。
- 任务与登录限流数据由 Cloud Functions 使用 EdgeOne Blob 保存；旧 `LEXI_KV` 数据通过只读接口迁移。
- 更换部署域名时，将 `LEXI_PUBLIC_ORIGIN` 设置为新站点的完整来源地址，供旧数据迁移接口使用。

当前 EdgeOne 同步实现按任务 ID 合并修改，保留删除标记，并通过清理版本阻止旧页面重新上传已清理的副本。浏览器会在接收清理结果前备份原有本地缓存。

运行环境、存储约定及上线验证步骤见 [`edgeone/README.md`](edgeone/README.md)。

### Cloudflare：仓库中的另一套部署入口

仓库保留 vinext / Cloudflare Workers 部署，使用 D1 的 `DB` 绑定保存任务。推送到 `main` 会触发 [Deploy to Cloudflare](.github/workflows/deploy-cloudflare.yml) 工作流，需要配置 `CLOUDFLARE_API_TOKEN` 仓库密钥以及对应的数据库绑定、访问密码和会话密钥。

EdgeOne Blob 与 Cloudflare D1 是两套独立的数据存储。切换部署入口时需要单独处理数据迁移。当前生产站点的同步维护说明以 EdgeOne 文档为准。
