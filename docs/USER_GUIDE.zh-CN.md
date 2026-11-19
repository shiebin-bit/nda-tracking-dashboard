# NDA Tracker 中文使用说明

[English README](../README.md) · [运维与排错](OPERATIONS.md) · [开发说明](DEVELOPMENT.md)

## 这个系统做什么

将合同准备、Word/PDF 生成、签署件保存、NDA 到期 tracking 和邮件提醒放在一个本机网站中。原来的 Excel 仍然可以导入/导出，提醒不再依赖 Power Automate。

目前使用固定的 FFM NDA 模板。合同草稿状态 Draft/Signed，与 tracking 的 Pending/Resolved 是两套不同状态。

## 开始使用

1. 安装并打开 Docker Desktop，等待 Linux 容器引擎运行。
2. 下载或 clone 仓库，在项目文件夹双击 `OPEN-NDA-DASHBOARD.cmd`。
3. 第一次会生成本机 `.env` 数据库密码，构建容器后打开 `http://127.0.0.1:5183`。
4. 新数据库没有工作记录，也不会自动导入原来的 11 条 Excel 资料。通过 Input、Import Excel 或 Contracts 建立自己的记录。

`.env`、数据库、备份和真实合同不会随 GitHub clone 一起复制。不要用 `.env.example` 覆盖已经在使用的 `.env`。普通关闭使用 `STOP-NDA-DASHBOARD.cmd`，资料仍在数据库中。

目前没有账号登录；能访问本机网站的人可以修改资料。现有设置只开放本机访问。

## 主要页面

| 页面 | 用法 |
| --- | --- |
| Overview | 看总数、待跟进和到期状态，搜索、筛选、导出 Excel，查看提醒状态 |
| Contracts | 填写合同、生成文件、上传签署 PDF、确认并关联 tracking |
| Input | 直接登记、修改或续约 tracking 记录 |
| History | 查看修改记录、导入、续约、处理备注、设置及恢复操作 |
| Settings | 配置邮件收件人、CC、提醒天数、检查时间及备份 |
| Recycle bin | 恢复误删的 agreement 或 contract |

## 一份合同的完整流程

1. **Contracts → New contract**：检查 FFM 默认资料，填写客户公司、注册号码、地址、Purpose、Duration，以及需要的联络人资料。
2. **Save draft**：资料不完整也可以保存。Duration 默认三年，可以修改，包括正数小数年。
3. **Generate Word & PDF**：双方公司名称、注册号码、地址、Purpose 和有效 Duration 必须齐全。未确定的日期、签署人、见证人可以先留白。
4. **预览、下载、打印**：每次生成保留自己的资料快照和 Word/PDF。修改草稿后需要重新生成；不会覆盖旧版本。
5. **拿去签署**：签名在系统外完成。
6. **Upload signed copy**：每份合同旁边及详情都有自己的入口。选择对应的完整生成版本，上传一份完整签署 PDF，最多 20 MiB。
7. **Confirm signed & start tracking**：预览核对文件、协议日期及 PIC 后确认，系统才标记 Signed，并建立或关联 Pending tracking。

只保存草稿、生成文件或上传 PDF 都不会开始 tracking 或触发提醒。系统记录人工确认，不会自动识别有没有签名，也不判断真伪。

误传时使用 **Replace signed copy**。旧文件保留，新文件不会改变 tracking 的日期、Duration 或状态。旧的 Signed 合同如果没有文件会显示 **Signed · File missing**，补传不会重复建档。

下载后的 Word 如果在外面修改，内容不会自动同步回网站。签完后的完整 PDF 要另行上传。

### 从已有 tracking 带入

Contracts → Use tracking record 可以从原记录建立关联草稿。如果确认时两边资料不一致，会列出差异，由用户明确修改原记录、刷新草稿并重新生成，或复制为新协议。系统不会静默覆盖资料；原本 Resolved 的记录不会自动重新变成 Pending。

### 批量合同

**Import Excel drafts** 用于导入合同资料，不是上传签署文件。先看逐行错误、缺失资料和疑似重复，再确认导入。导入的草稿不自动进入 tracking，也不覆盖现有记录。

可选择最多 100 份草稿一起生成。任务显示进度，ZIP 包含成功的 Word/PDF 和结果清单。部分失败可以重试；PDF 转换失败时保留已经生成的 Word。

## Excel 与 tracking

Overview 的 **Import Excel** 先预览并检查，不会自动覆盖现有记录；完全重复会跳过，疑似重复需要检查。上传 `.xlsx`，最大 5 MB。

**Export Excel** 可选当前筛选结果或所有记录。当前筛选会导出全部匹配资料，包括其他分页。保留原本 26 个栏位、顺序及编号，重复编号不会合并。工作簿另有说明表，记录导出范围、时间、条件和数量。

到期日及剩余天数按导出当天的马来西亚日期计算，写成固定值。过几天想要最新天数就重新导出。Excel 导出不是完整数据库备份。

Input 可以直接新增或编辑记录。Renew 建立关联的新记录，并把旧记录改为 Resolved。另一窗口已经修改同一记录时，会提示版本冲突，需要刷新核对。

## 天数怎样计算

现有计算沿用原 Excel 的固定天数规则：`trunc(Duration × 365)` 天加在协议日期上。它不是按日历加几年。小数年数先换成整天。

网站按当天马来西亚日期重新计算剩余天数，无需每天手动加减。缺少或无效的日期/Duration 不参与提醒。

## 邮件提醒

邮件由后端使用 Brevo API 发出，可以寄到 Outlook、学校邮箱或其他邮箱；不用 Microsoft Entra，也不用 Power Automate。

1. 在本机 `.env` 加入 `BREVO_API_KEY`，保留数据库密码。
2. 在项目目录执行 `docker compose up -d --build --wait app` 重新载入配置。
3. Settings 检查 Brevo 连接，保存已验证的寄件人。
4. 按需要明确发送测试邮件并检查收件箱。
5. 保存正式收件人、可选 CC、时间和提醒天数，再勾选 Enable automatic reminders 并保存。

收件地址来自 Settings。Excel 的 Recipient 是合同客户公司，不是提醒收件人。

- 默认每天 09:00 MYT 检查，可以修改。
- 默认 90、60、45、30 天，准确命中当天天数才提醒，可以增删修改。
- 已过期且 Pending，每天进入提醒候选，直到 Resolved 或移到回收站。
- 0 天显示 Due today，按现有规则当天不加入邮件候选。
- 没有候选就不寄信。
- Preview email 只预览，不寄信。
- Submitted 表示 Brevo 接受请求，不等于保证送达。
- Failed 可查看原因并按规则重试；Needs review 表示结果不确定，不会自动重发。

浏览器可以关闭，**电脑和 Docker 要持续运行**。重启后只处理当天尚未处理的任务，不追发过去日期。把代码放到 GitHub 不会让后台变成长期在线服务。

## History、备注和删除

Agreement 详情可追加 Follow-up notes，最多 2000 字符，保存时间及 Local user，History 也能找到。备注不能改写，补充更正可新增一条。

Delete 会移到回收站，可恢复。删除 agreement 会排除之后的提醒，但不删除关联 contract；只删除 contract 不改变关联 tracking 的提醒。文件及 History 保留，已经提交的邮件不会撤回。

续约链要从最新的后续记录开始删除，恢复则先恢复前一份协议。系统没有永久删除按钮。

## 备份与恢复

- Settings 的 **NDA register JSON** 只含有效 tracking、History、备注和提醒设置，不含合同文件或独立邮件记录。恢复会暂停自动提醒，保留合同文件。
- **完整 PostgreSQL 备份** 包含合同草稿、生成版本、签署 PDF、回收站及邮件任务记录。
- 自动完整备份首次建立，之后每天 02:00 MYT，保留 14 份成功自动备份。
- 手动完整备份双击 `BACKUP-DATABASE.cmd`。
- `.env` 和邮件密钥不在数据库备份里，要另外妥善保存。

有 agreement 在回收站时，需要先恢复它们，才能执行 JSON / Saved versions 整体恢复。备份存在同一台电脑，重要资料建议再复制到其他存储。完整数据库恢复步骤见 [Operations](OPERATIONS.md)。

## DataGrip 连接

Host `127.0.0.1`、Port `5433`、Database `nda_tracker`、User `nda_app`。密码使用本机 `.env` 的 `NDA_DB_PASSWORD`，Docker 要运行。只查看资料时，建议使用 DataGrip 的只读模式。

## 当前版本没有包括

多人账号/权限、电子签名、完整 Word 排版编辑器、照片合并签署件、自动识别签名、云端长期在线部署。正式多人使用或开放互联网前，需要额外设计访问控制和部署。

## Supplier、项目和模板

在 Suppliers 建立现有 Supplier ID；请保留前导零。旧 agreement 需手动关联，不会按公司名称自动合并。同一 supplier 可关联多个项目，并集中查看 NDA 与 EOI。Supplier ID 只用于网站，不放进合同或原格式 Excel 导出。

Contracts 可选择 NDA 或 EOI、supplier、项目及已发布模板。EOI 确认签署只保存签署状态，不产生 NDA tracking 或到期提醒。同项目缺少已签 EOI 时会提示，但仍可继续 NDA。

Templates 支持导入 Word、PDF。Word 可按段落或表格单元格改文字和字段；PDF 保留原页面，在指定位置填写字段。先保存、预览，再发布新版，旧文件不变。PDF 模板只生成 PDF，不提供 Word 下载。每份文件最大 20 MiB。

Settings 的 CC 可逐个添加最多十个邮箱；重复及与 To 相同的地址会排除。正式邮件会显示 CC 名单，测试邮件不抄送。完整说明见 [Supplier 和模板指南](SUPPLIERS_AND_TEMPLATES.md)。

## 新增文件与现有资料归类

Documents 统一使用 **New document**，先选已发布模板，再填写 supplier、项目及文件资料。Supplier 详情的 **Assign existing items** 可搜索、多选现有 document 或 agreement，提交前会列出关联 tracking 与文件的完整归类清单；已归到别的 Supplier 的项目会明确提示。

现有及新增 agreement 自动取得 `AGR-000001` 这类网站编号；document 使用 `DOC-000001`。编号在编辑、归类、删除恢复后保持不变，可用来搜索。原 Excel 编号、26栏、数据库ID及合同文件内容不受影响。
