import { addPlayer, applyRoomAction, createRoom } from '../public/src/room.js';
import { CODE, Obj } from '../public/src/types.js';
import { researchClueText, researchTopicName } from './research.js';

const OBJECTS = Object.freeze([
  Obj.ASTEROID, Obj.COMET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.GAS_CLOUD, Obj.PLANET_X,
  Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.ASTEROID,
]);

function createTutorialPuzzle() {
  const features = [
    { kind: 'band', objectType: Obj.GAS_CLOUD, length: 3 },
    { kind: 'band', objectType: Obj.ASTEROID, length: 5 },
    { kind: 'relation', objectType: Obj.COMET, neighborType: Obj.ASTEROID, relation: 'adjacent', quantifier: 'all' },
    { kind: 'relation', objectType: Obj.DWARF_PLANET, neighborType: Obj.COMET, relation: 'adjacent', quantifier: 'all' },
    { kind: 'relation', objectType: Obj.GAS_CLOUD, neighborType: Obj.DWARF_PLANET, relation: 'within', range: 2, quantifier: 'some' },
    { kind: 'relation', objectType: Obj.ASTEROID, neighborType: Obj.GAS_CLOUD, relation: 'adjacent', quantifier: 'none' },
  ];
  const conference = { kind: 'relation', objectType: Obj.GAS_CLOUD, neighborType: Obj.PLANET_X, relation: 'adjacent', quantifier: 'all' };
  return {
    modeId: 'standard',
    objects: [...OBJECTS],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic, index) => [topic, {
      name: researchTopicName(features[index]), clue: researchClueText(features[index]), feature: features[index],
    }])),
    conferenceNames: { 10: 'X行星和气体云' },
    conferences: { 10: researchClueText(conference) },
    startingClues: [
      [{ sector: 0, objectType: Obj.GAS_CLOUD }, { sector: 2, objectType: Obj.ASTEROID }, { sector: 7, objectType: Obj.DWARF_PLANET }, { sector: 10, objectType: Obj.GAS_CLOUD }],
      [{ sector: 1, objectType: Obj.GAS_CLOUD }, { sector: 3, objectType: Obj.DWARF_PLANET }, { sector: 8, objectType: Obj.GAS_CLOUD }, { sector: 11, objectType: Obj.DWARF_PLANET }],
    ],
  };
}

function lesson(id, chapter, title, focus, text, options = {}) {
  return { id, chapter, title, focus, text, interaction: 'continue', actor: 'human', ...options };
}

const LESSONS = [
  lesson('welcome', 1, '欢迎来到寻找 X 行星', 'map', [
    '这是一局固定的 12 扇区双人教学：你负责推理，领航员 Bot 按预设合法行动配合。',
    '星图每格恰有一种内容。X 行星在勘测与扫描中看起来像空域；目标是找出它及左右邻居。',
    '已通过正常开局为你分发 4 条私有排除线索，星图上的叉号就是这些已知信息。',
  ]),
  lesson('inspect', 1, '先读懂一格星图', 'map', [
    '点击 1 号扇区，找到气体云图标上的排除标记：你的初始线索告诉你这里没有气体云。',
    '亮起的半圈是当前可见天区；太阳旁的地球随天窗转动。只能在可见天区勘测或扫描。',
  ], { interaction: 'inspect', expected: { sector: 0 } }),
  lesson('survey', 2, '第一次勘测：5 号气体云', 'survey', [
    '选择勘测与气体云，在星图上把起点、终点都选为 5 号，再确认。',
    '勘测返回一段连续天区内某种天体的数量。只查 1 格需要 4 个时间单位；范围越大，耗时越少但信息更模糊。',
  ], { interaction: 'action', action: { kind: 'survey', type: Obj.GAS_CLOUD, start: 4, size: 1 } }),
  lesson('survey-result', 2, '把观测变成确定信息', 'map', [
    '刚才只查了 5 号，结果为 1：所以 5 号一定有气体云，结果已记入你的星图。',
    '你的棋子前进了 4 个时间单位。Bot 还在起点，因此天窗尚未移动，接下来轮到落后的 Bot。',
  ]),
  lesson('bot-first', 3, '观看 Bot 的第一次行动', 'timeline', [
    '点击“观看 Bot”，它会完成一次合法扫描。你只能看到它扫描了哪里，不能看见私有结果。',
    '观察它落到你所在位置时的前后顺序，以及天窗起点离开 3 号时触发的学术研究。',
  ], { actor: 'bot', action: { kind: 'target', sector: 2 } }),
  lesson('arrival-order', 3, '同格时，先到者在后并先执行', 'timeline', [
    '现在两人都耗时 4。后到的 Bot 放在该格所有棋子的前方，你仍是落后者。',
    '行动和论文提交都由落后者先执行；同格时是先到者优先，不是后来挤到前方的人优先。',
  ]),
  lesson('declare-first', 4, '学术研究：先声明 1 篇', 'theory', [
    '天窗起点离开 3 号后，双方共同进入学术研究阶段。每人先确定篇数，再按落后顺序提交。',
    '本次选择提交 1 篇。我们已有可靠的 5 号气体云证据。',
  ], { interaction: 'action', action: { kind: 'research-declare', count: 1 } }),
  lesson('bot-declare-first', 4, '等待 Bot 声明篇数', 'theory', [
    'Bot 也声明 1 篇。双方声明完成后，落后的你先提交。',
  ], { actor: 'bot', action: { kind: 'research-declare', count: 1 } }),
  lesson('publish-first', 4, '提交 5 号气体云论文', 'theory', [
    '选择 5 号扇区和气体云，提交论文。其他人暂时只知道你对 5 号作了预测，不知道预测的天体。',
  ], { interaction: 'action', action: { kind: 'research-submit', sector: 4, objectType: Obj.GAS_CLOUD } }),
  lesson('bot-publish-first', 4, '观看 Bot 提交论文', 'theory', [
    '轮到 Bot 提交它的私有预测。所有人完成后，论文一起沿轨道推进，不立即揭晓内容。',
  ], { actor: 'bot', action: { kind: 'research-submit', sector: 2, objectType: Obj.DWARF_PLANET } }),
  lesson('theory-track', 4, '在左侧追踪论文进度', 'theory', [
    '星图左侧的进度表按扇区列出论文和所在轨道。到达评审格后，系统才判定对错。',
    '同一扇区尚未正确揭示时，以后可以换一种天体再提交，但不能重复自己的相同预测。',
  ]),
  lesson('scan', 5, '扫描 6 号扇区', 'target', [
    '选择扫描，点击可见天区内的 6 号并确认。扫描只看一格，耗时 4；每人整局最多 2 次。',
  ], { interaction: 'action', action: { kind: 'target', sector: 5 } }),
  lesson('scan-result', 5, '空域不等于真正没有天体', 'target', [
    '扫描 6 号返回“空域”。这排除了四种普通天体，却无法区分真正的空域和 X 行星。',
    '因此不要直接排除 X。后续需要公共规则、研究和会议来区分。',
  ]),
  lesson('bot-second', 5, '观看 Bot 勘测', 'timeline', [
    'Bot 完成一次可见天区内的勘测。当天窗起点离开 6 号时，会开启下一次学术研究。',
  ], { actor: 'bot', action: { kind: 'survey', type: Obj.ASTEROID, start: 8, size: 1 } }),
  lesson('declare-second', 5, '没有新把握时可以不提交', 'theory', [
    '本次选择 0 篇。6 号的“空域”不是可提交的普通天体结论，不能把它当作确定论文。',
  ], { interaction: 'action', action: { kind: 'research-declare', count: 0 } }),
  lesson('bot-declare-second', 5, 'Bot 声明一篇新预测', 'theory', [
    'Bot 会声明一篇新论文。观察流程即可，它的具体结论仍然保密。',
  ], { actor: 'bot', action: { kind: 'research-declare', count: 1 } }),
  lesson('bot-publish-second', 5, '观看第二次论文推进', 'theory', [
    'Bot 提交后，本阶段结束，所有待评审论文再前进一格。',
  ], { actor: 'bot', action: { kind: 'research-submit', sector: 7, objectType: Obj.ASTEROID } }),
  lesson('research', 6, '研究课题 A：气体云', 'research', [
    '选择研究，再选择左侧的 A 课题并确认。研究耗时 1；不能连续两次研究，也不能重复同一课题。',
    '单天体课题描述分布范围；两种天体课题描述相邻、正对或一定距离以内等关系。',
  ], { interaction: 'action', action: { kind: 'research', topic: 'A' } }),
  lesson('research-result', 6, '把范围线索和实测信息结合', 'research', [
    '你获知：所有气体云都位于不超过 3 个连续扇区内。结合 5 号的气体云，可缩小另一片气体云的范围。',
    '研究正文只有做过该课题的玩家可见，A—F 标题则一直向全桌展示。',
  ]),
  lesson('bot-research', 6, '观看 Bot 研究另一个课题', 'timeline', [
    'Bot 研究自己的课题，耗时 1。两人都推进后，天窗起点离开 9 号，开启第三次学术研究。',
  ], { actor: 'bot', action: { kind: 'research', topic: 'B' } }),
  lesson('declare-third', 7, '选择 0 篇，等待首轮评审', 'theory', [
    '本次仍选择 0 篇。双方声明后，最早的论文将到达评审位置。',
  ], { interaction: 'action', action: { kind: 'research-declare', count: 0 } }),
  lesson('bot-declare-third', 7, '观看首轮评审', 'theory', [
    'Bot 也选择 0 篇。系统随后按正式规则评审到期论文，不需要手动填写对错。',
  ], { actor: 'bot', action: { kind: 'research-declare', count: 0 } }),
  lesson('review-correct', 7, '正确论文成为公共信息', 'theory', [
    '评审确认：你的 5 号气体云和 Bot 的 3 号矮行星都正确，现在对全桌公开。',
    '正确揭示的扇区不再允许投稿。正确论文和首次定位该扇区的奖励会进入积分表。',
  ]),
  lesson('survey-comet', 8, '在合法彗星扇区继续观测', 'survey', [
    '勘测 11 号的彗星：选择彗星，把起点和终点都设为 11 号。',
    '彗星只可能出现在质数编号扇区；勘测彗星的两个端点也必须是当前可见的合法彗星扇区。',
  ], { interaction: 'action', action: { kind: 'survey', type: Obj.COMET, start: 10, size: 1 } }),
  lesson('bot-fourth', 8, '让天窗经过 X 行星会议', 'timeline', [
    'Bot 再做一次合法勘测。天窗起点离开 10 号时，X 行星会议向所有人公开同一条关系线索。',
    '跨过多个事件时，会议与学术研究依照沿途先后顺序处理。',
  ], { actor: 'bot', action: { kind: 'survey', type: Obj.ASTEROID, start: 11, size: 1 } }),
  lesson('conference', 8, '读取常驻左栏的会议线索', 'conference', [
    '会议已公开：“每个气体云都与 X 行星相邻。”会议标题从开局就可见，正文只有会议触发后才公开。',
    '先完成眼前的学术研究与评审，再用这条线索推理 X 的位置。',
  ]),
  lesson('declare-fourth', 8, '本阶段选择 0 篇', 'theory', [
    '暂时不追加论文，选择 0 篇，让已提交的预测进入下一次评审。',
  ], { interaction: 'action', action: { kind: 'research-declare', count: 0 } }),
  lesson('bot-declare-fourth', 8, '观看下一次同行评审', 'theory', [
    'Bot 也选择 0 篇。系统会评审它较早提交的另一篇论文。',
  ], { actor: 'bot', action: { kind: 'research-declare', count: 0 } }),
  lesson('review-wrong', 8, '错误论文会罚时', 'timeline', [
    'Bot 对 8 号的预测错误，按规则前进 1 个时间单位；错误并不会揭晓该扇区的真实内容。',
    '你耗时 13，Bot 耗时 14，因此接下来仍由你这个落后者行动。',
  ]),
  lesson('deduction', 9, '把证据连起来，定位 X', 'locate', [
    '5 号是气体云，而每片气体云都邻接 X，所以 X 只能在 4 号或 6 号。',
    '3 号已公开为矮行星，基础规则禁止 X 邻接矮行星，因此排除 4 号，得到 X 在 6 号。',
    '全盘共有两片气体云，且它们都邻接 X，所以 6 号的两个邻居 5 号、7 号都是气体云。6 号扫描呈空域也与 X 的特性吻合。',
  ]),
  lesson('mark-x', 9, '亲手标记你的推理结果', 'map', [
    '点击 6 号扇区内的 X 图标，选择“确定存在”。这次标记来自刚刚得到的证据，而不是系统提前给出答案。',
  ], { interaction: 'mark', expected: { sector: 5, code: CODE[Obj.PLANET_X], markState: 'yes' } }),
  lesson('locate-x', 9, '正式定位：6 号，两侧气体云', 'locate', [
    '打开定位 X 行星，填写 X 在 6 号，左邻居为气体云，右邻居也为气体云，再提交。',
    '定位耗时 5。只有位置和两侧真实天体全部正确，才会进入最后得分机会。',
  ], { interaction: 'action', action: { kind: 'locate', sector: 5, left: Obj.GAS_CLOUD, right: Obj.GAS_CLOUD } }),
  lesson('final-chance', 10, '观看 Bot 的最后得分机会', 'score', [
    '你已正确定位。其他仍在你后方的玩家还有一次最后机会，可以定位、提交规定篇数的论文，或者放弃。',
    '本教学中 Bot 选择放弃。点击后由正式规则揭晓全盘并完成计分。',
  ], { actor: 'bot', action: { kind: 'final-pass' } }),
  lesson('complete', 10, '教学完成，开始独立探索吧', 'score', [
    '你已亲手完成勘测、扫描、研究、论文、会议推理与定位。积分表展示了正确论文、首次定位与定位 X 的得分来源。',
    '教学 Bot 只是合法行动脚本，不会自行推理。接下来可以重玩教学，或退出后选择 12／18 扇区内置谜题。',
    '当前房间进度支持刷新恢复；服务器重启仍会清空房间，请先结束对局再重启。',
  ], { interaction: 'complete' }),
];

function stepAction(room, step) {
  if (!step.action) return null;
  const action = { ...step.action };
  if (['research-declare', 'research-submit'].includes(action.kind)) action.phaseId = room.research?.id;
  return action;
}

function updateTutorialView(room) {
  const state = room.tutorialState;
  const step = LESSONS[state.index];
  room.tutorialView = {
    stepId: `${room.id}:${state.index}:${step.id}`,
    chapter: step.chapter,
    chapterCount: 10,
    title: step.title,
    text: [...step.text],
    focus: step.focus,
    interaction: step.interaction,
    actor: step.actor,
    expected: step.actor === 'bot' ? null : stepAction(room, step) || (step.expected ? { ...step.expected } : null),
    nextLabel: step.actor === 'bot' ? '观看 Bot' : '继续',
    completed: step.interaction === 'complete',
  };
}

export function createTutorialRoom({ hostName = '新手' } = {}) {
  const room = createRoom({ modeId: 'standard', hostName, playMode: 'builtin', puzzle: createTutorialPuzzle(), initialClueCount: 4 });
  const bot = addPlayer(room, '领航员 Bot');
  bot.bot = true;
  for (const [playerId, action] of [
    [room.hostId, { kind: 'start-game' }],
    [room.hostId, { kind: 'setup' }],
    [bot.id, { kind: 'setup' }],
  ]) {
    const result = applyRoomAction(room, playerId, action);
    if (!result.ok) throw new Error(`无法开始教学：${result.error}`);
  }
  room.tutorialState = { humanId: room.hostId, botId: bot.id, index: 0 };
  updateTutorialView(room);
  return room;
}

export function applyTutorialAction(room, playerId, action) {
  const state = room.tutorialState;
  if (!state || playerId !== state.humanId) return { ok: false, error: '教学 Bot 由脚本控制，只能由本局真人推进教学' };
  const guide = room.tutorialView;
  if (!action || action.stepId !== guide.stepId) return { ok: false, error: '教学进度已更新，请按当前步骤重试' };
  if (guide.completed) return { ok: false, error: '教学已完成，可以重玩或退出教学' };
  const step = LESSONS[state.index];
  const expected = guide.expected;
  const requiredKind = step.interaction === 'action' ? expected.kind
    : step.interaction === 'inspect' ? 'tutorial-inspect'
      : step.interaction === 'mark' ? 'tutorial-mark' : 'tutorial-next';
  if (action.kind !== requiredKind || (expected && !Object.entries(expected).every(([key, value]) => action[key] === value))) {
    return { ok: false, error: `当前练习：${step.title}。请按引导选择操作；这次没有消耗时间或次数。` };
  }
  let result = { ok: true };
  if (step.actor === 'bot' || step.interaction === 'action') {
    result = applyRoomAction(room, step.actor === 'bot' ? state.botId : state.humanId, stepAction(room, step));
    if (!result.ok) return result;
  }
  state.index += 1;
  updateTutorialView(room);
  return step.actor === 'bot' ? { ok: true } : result;
}
