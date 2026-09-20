# 原版风格研究线索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 内置研究采用单／双天体命题，每题一条原版风格的空间关系规则。

**Architecture:** 独立纯函数模块表达谓词和文字；现有枚举器负责有效特征筛选、六主题采样、会议可区分性和候选校验。原有房间、查询与隐私协议保持不变。

**Tech Stack:** 零依赖 JavaScript ES modules、Node.js 内置测试、DOM/SVG UI 与隔离浏览器验收。

**Spec:** `docs/superpowers/specs/2026-09-20-research-templates-design.md`。

---

## Task 1：研究谓词纯模块

**Files:** 创建 `server/research.js`、`tests/research.test.js`。

- [x] 先写测试并观察失败，接口和中文模板严格按设计文档。
- [x] 实现 `buildResearchFeatures`、`researchFeatureValue`、`researchTopicName`、`researchClueText`。
- [x] 用独立的扇区数组／距离解释器测试全部特征，覆盖转动与镜像不变性、跨零范围、量词和边界。
- [x] 运行 `node tests/research.test.js`，确认全部通过；不得修改其他文件或运行现有服务。

## Task 2：重接谜题生成与独立预言机

**Files:** `server/puzzles.js`、`tests/puzzles.test.js`、`tests/all.test.js`。

- [x] 增加课题标题／单句格式与镜像候选回归，先在原生成器上观察失败。
- [x] 导入纯模块，仅取真且非恒真的研究谓词；按 `topicKey` 去重，最多两道有效单体题，其余为双体题，打乱后分配 A–F。
- [x] 删除追加联合线索的循环，六题各一句；低收益时退回基础候选集选真实、有信息量的题，不重抽答案。
- [x] 会议选项必须在完整观测等价类中唯一确定答案；保留原会议文本、时间与发布路径。
- [x] 测试预言机独立解析新的中文范围与量词，完整观测与会议联合解必须为单一完整棋盘，静态研究解不再强制为一。
- [x] 把 `research.test.js` 加入全量入口，运行两个定向测试文件及显式穷举。

## Task 3：研究说明、文档与全链路验证

**Files:** `public/ui/panels.js`、`public/styles.css`、`tests/ui.smoke.test.js`、`README.md`、本计划与新增验证证据。

- [x] 先验证内置研究说明需求，再添加折叠的空间关系／量词说明；记录模式不变，不泄露未研究内容。
- [x] 修复浏览器验收发现的双天体课题名称截断，补充换行回归并检查桌面／窄屏实际布局。
- [x] 更新当前 README 的模板说明和可解性承诺，保留历史报告与已有证据原样。
- [x] 执行 `PUZZLE_EXHAUSTIVE=1 node tests/all.test.js`，单独记录已知旧启动文件名失败，不能声称全套通过。
- [x] 使用临时复制目录、随机／独立端口验证真实研究结果、历史、未研究正文保密及窄屏布局；不重启用户服务。
- [ ] 独立规格审查和代码审查，修复本次范围内的问题后复验；不提交、不创建 Git 仓库。
