'use strict';

/**
 * 真机（模拟器）验收脚本：用 miniprogram-automator 驱动微信开发者工具，
 * 逐个页面截图，并对**真实渲染出来的数据**做断言。
 *
 * 前置条件（三个都要满足）：
 *   1. 开发者工具 → 设置 → 安全设置 → 服务端口：开启
 *   2. 装一下 automator：npm i --no-save miniprogram-automator
 *   3. project.config.json 的 appid 是可用的（本地验证临时改成 touristappid 即可，
 *      跑完记得改回你自己的 AppID）
 *
 * 用法：
 *   node test-utils/e2e-screenshots.js
 *
 * 截图输出到 screenshots/（已在 .gitignore 里，属于生成物）。
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const OUT = path.join(PROJECT, 'screenshots');
const WAIT = 2600;

const results = [];
/** 海报临时文件路径，最后一步预览用 */
let posterFilePath = null;

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shot(mp, name) {
  const file = path.join(OUT, `${name}.png`);
  try {
    await mp.screenshot({ path: file });
    console.log(`  · 截图 ${path.relative(PROJECT, file)}`);
  } catch (e) {
    // 截图失败不该让断言白跑一遍
    console.log(`  · 截图失败(${name}): ${(e && e.message) || e}`);
  }
  return file;
}

async function main() {
  // eslint-disable-next-line global-require
  const automator = require('miniprogram-automator');
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n启动微信开发者工具（自动化模式）…');
  const mp = await automator.launch({
    cliPath: CLI,
    projectPath: PROJECT,
    timeout: 180000
  });
  console.log('已连接。\n');

  try {
    // ---------------- 首页
    await mp.reLaunch('/pages/home/home');
    await sleep(WAIT);
    const home = await mp.currentPage();
    const homeData = await home.data();

    check('首页拿到数据', homeData && homeData.summary, JSON.stringify(homeData && homeData.summary));
    check('首页标题是「N 样该买了」', /该买了|不用买/.test(homeData.headline.title), homeData.headline.title);
    check('首页有 2 样待补货', homeData.refill.length === 2, `${homeData.refill.length} 样：${homeData.refill.map((c) => c.name).join('、')}`);
    check('待补货里有已用完的', homeData.refill.some((c) => c.badge === '已用完'));
    check('首页有 4 样还够用', homeData.ok.length === 4, homeData.ok.map((c) => c.name).join('、'));
    // 断言跟着总开关走：打开时该出现续订卡，关闭时该收起来
    const pushOn = /PUSH_ENABLED:\s*true/.test(
      fs.readFileSync(path.join(PROJECT, 'miniprogram', 'config.js'), 'utf8')
    );
    check(
      pushOn ? '推送打开：额度不足时出现续订卡' : '推送关闭：不出现续订卡',
      homeData.showQuotaTip === pushOn,
      `PUSH_ENABLED=${pushOn}`
    );
    await shot(mp, '01-home');

    // 记一笔面板
    await home.callMethod('openSheet');
    await sleep(1500);
    const sheetData = await home.data();
    check('记一笔宫格加载出常用物品', sheetData.quickItems.length >= 6, `${sheetData.quickItems.length} 个`);
    await shot(mp, '02-quick-sheet');

    // 点一下宫格记一笔
    const paperId = sheetData.quickItems[0].id;
    await home.callMethod('addOne', paperId, 1);
    await sleep(1200);
    const afterAdd = await home.data();
    check('点一下记上一笔并出现撤销条', Boolean(afterAdd.undo), afterAdd.undo && afterAdd.undo.label);
    await shot(mp, '03-after-add');

    await home.callMethod('undoAdd');
    await sleep(1200);
    check('撤销后撤销条消失', (await home.data()).undo === null);

    await home.callMethod('closeSheet');
    await sleep(1500);

    // 清单海报：离屏 canvas 真画一张出来（发家庭群用）
    // automator 不会 await 异步页面方法，所以从页面 data 里读结果
    await home.callMethod('drawPoster');
    await sleep(3000);
    const posterPath = (await home.data()).posterPath;
    check('清单海报能画出来', typeof posterPath === 'string' && posterPath.length > 0, String(posterPath));
    posterFilePath = posterPath;

    // ---------------- 物品页
    await mp.switchTab('/pages/items/items');
    await sleep(WAIT);
    const items = await mp.currentPage();
    const itemsData = await items.data();
    check('物品页有 6 样物品', itemsData.total === 6, `${itemsData.total}`);
    check('物品按分类分组', itemsData.groups.length >= 4, itemsData.groups.map((g) => g.category).join('、'));
    await shot(mp, '04-items');

    // ---------------- 物品详情
    const paper = itemsData.groups.reduce((acc, g) => acc.concat(g.items), []).find((i) => i.name === '抽纸');
    await mp.navigateTo(`/pages/item-detail/item-detail?id=${paper.id}`);
    await sleep(WAIT);
    const detail = await mp.currentPage();
    const detailData = await detail.data();
    check('详情页显示已用完', detailData.stockText === '已用完', detailData.stockText);
    check('详情页有历史时间轴', detailData.timeline.length >= 3, `${detailData.timeline.length} 条`);
    check('详情页解释了估算依据', Boolean(detailData.basisText));
    await shot(mp, '05-item-detail');

    // ---------------- 编辑物品
    await mp.navigateTo('/pages/item-edit/item-edit');
    await sleep(WAIT);
    await shot(mp, '06-item-edit');
    await mp.navigateBack();
    await sleep(1200);

    // ---------------- 统计页
    await mp.switchTab('/pages/stats/stats');
    await sleep(WAIT);
    const stats = await mp.currentPage();
    const statsData = await stats.data();
    check('统计页有本月金额', Boolean(statsData.view && statsData.view.totalText), statsData.view && statsData.view.totalText);
    check('统计页有分类占比', statsData.view.bars.length >= 1);
    check('统计页有 6 个月趋势', statsData.view.trendBars.length === 6);
    check('统计页有预计月开销', statsData.view.predicted.length >= 4, statsData.view.predictedTotalText);
    await shot(mp, '07-stats');

    // ---------------- 我的 / 家庭 / 设置
    await mp.switchTab('/pages/me/me');
    await sleep(WAIT);
    const me = await mp.currentPage();
    check('我的页显示演示模式提示', (await me.data()).isMock === true);
    await shot(mp, '08-me');

    await mp.navigateTo('/pages/family/family');
    await sleep(WAIT);
    const family = await mp.currentPage();
    check('家庭页显示邀请码', Boolean((await family.data()).inviteCode), (await family.data()).inviteCode);
    await shot(mp, '09-family');
    await mp.navigateBack();
    await sleep(1200);

    await mp.navigateTo('/pages/settings/settings');
    await sleep(WAIT);
    const settings = await mp.currentPage();
    check(
      '设置页的推送入口与总开关一致',
      (await settings.data()).pushFeatureOn === pushOn,
      `pushFeatureOn=${(await settings.data()).pushFeatureOn}`
    );
    await shot(mp, '10-settings');
    await mp.navigateBack();
    await sleep(1200);

    // ---------------- 首次使用页
    await mp.navigateTo('/pages/onboarding/onboarding');
    await sleep(WAIT);
    await shot(mp, '11-onboarding');
    await mp.navigateBack();
    await sleep(1200);

    // ---- 海报预览放到最后：previewImage 是原生浮层，一旦打开会挡住之后所有截图
    if (posterFilePath) {
      await mp.switchTab('/pages/home/home');
      await sleep(WAIT);
      await mp.evaluate((src) => {
        wx.previewImage({ urls: [src], current: src });
      }, posterFilePath);
      await sleep(1500);
      await shot(mp, '12-poster');
    }
  } finally {
    await mp.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) {
    console.log('未通过：');
    failed.forEach((r) => console.log(`  ✗ ${r.name}`));
    process.exit(1);
  }
  console.log(`截图已保存到 ${path.relative(PROJECT, OUT)}/\n`);
}

main().catch((e) => {
  console.error('\n失败：', (e && e.message) || e);
  if (/service port|服务端口/i.test(String((e && e.message) || ''))) {
    console.error('请在开发者工具里打开：设置 → 安全设置 → 服务端口。');
  }
  process.exit(1);
});
