# 初始线索类型修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 初始线索只说明某扇区不包含某种普通天体，不提供空域或 X行星的排除信息。

**Architecture:** 在共享类型模块定义初始线索的四类天体白名单，供谜题生成、服务端校验和记录模式表单共同使用。初始线索求解校验使用相同白名单；扫描、勘测、研究和会议规则不变。

**Tech Stack:** 原生 JavaScript ES modules、Node.js 内置测试、现有 DOM stub。

---

## 范围与边界

- 允许小行星、彗星、气体云、矮行星的否定式线索，每位玩家仍获 4 条私有初始线索。
- 标准盘有效排除池为 39 条：9 个普通天体扇区各 3 条，2 个真正空域与 1 个 X行星扇区各 4 条。采样上限按实际候选池长度校验。
- 记录模式的标准盘和专家盘均移除空域选项，拒绝绕过 UI 提交的空域／X行星初始线索。
- 不自动迁移已有对局，不停止或重启正在运行的项目服务；修改在服务重启后的新对局生效。
- 本目录不是 Git 仓库，不创建分支或提交。

## Task 1：先固定回归断言

**Files:** `tests/puzzles.test.js`、`tests/room.test.js`、`tests/ui.smoke.test.js`

- [x] 使用独立白名单验证每条初始线索的类型、真实性与去重；完整采样数从 48 修正为 39，40 起拒绝。
- [x] 初始线索求解校验拒绝 `Obj.EMPTY` 和 `Obj.PLANET_X`；保留真正空域与 X行星不能由普通天体排除信息直接区分的测试。
- [x] 标准／专家记录模式验证四种普通天体都能提交，空域／X行星提交失败且不修改准备卡。
- [x] 通过真实表单渲染检查初始线索下拉框恰有四个选项：

```js
assert.deepEqual(options.map((option) => option.attributes.value), [
  Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET,
]);
```

- [x] 分别运行 `node tests/puzzles.test.js`、`node tests/room.test.js`、`node tests/ui.smoke.test.js`，确认因原实现仍允许空域而失败。

## Task 2：修正数据来源与输入边界

**Files:** `public/src/types.js`、`server/puzzles.js`、`public/src/room.js`、`public/ui/panels.js`

- [x] 增加共享白名单：

```js
export const INITIAL_CLUE_TYPES = Object.freeze([
  Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET,
]);
```

- [x] 生成器从 `INITIAL_CLUE_TYPES` 构造排除池，采样上限使用 `exclusions.length`；求解器同样拒绝非白名单类型。
- [x] 房间模型保留 `CLUE_TYPES` 导出并指向共享白名单；表单直接复用该导出，删除重复定义。
- [x] 修改初始线索说明与输入错误信息，不改 `SURVEY_TYPES`、观测结果或研究／会议线索。
- [x] 重跑三个定向测试文件，确认通过。

## Task 3：验证与交付

**Files:** `README.md`、`audit/evidence/initial-clue-types-tests-2026-09-20.txt`

- [x] README 明确初始线索与空域观测的区别，保留历史报告原样。
- [x] 运行 `PUZZLE_EXHAUSTIVE=1 node tests/all.test.js`，覆盖全部 4,446 张合法标准盘及每盘 6 组初始线索；保存新的独立测试证据。
- [x] 自查只改变初始线索范围，并告知用户服务未重启、现有对局未修改。

## 验证结果

- 先观察到原实现的 7 项回归失败，涉及错误空域类型、旧候选池上限、求解器入参、房间校验和实际下拉框。
- 修正后定向运行：谜题 19 通过／1 个显式穷举跳过，房间 44 通过，界面 50 通过。
- 显式穷举全量运行：13 文件、277 项，275 通过、2 失败、0 跳过。全部 4,446 张合法盘与 26,676 组初始手牌通过验证。
- 两项失败均由工作区启停脚本增加 `mac`／`Windows-` 文件名前缀、现有启停测试仍引用旧名导致；属于本次初始线索修正以外的文件名不一致。保留现有命名，未修改或还原这些脚本，也未扩大范围修改启停测试。
- 全量测试使用临时服务，没有停止或重启用户服务，没有改写用户对局。
- 独立只读审查未发现本次范围内的阻塞问题；确认生成、输入校验和界面一致，正常空域观测及研究／会议范围保持不变。
