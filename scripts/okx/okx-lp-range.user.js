// ==UserScript==
// @name         OKX LP 区间快捷设置（稳定币偏重）
// @namespace    local.codex.okx.lp-range
// @version      1.3.5
// @description  按现价快速填写 OKX Uniswap V3 的价格区间；不填写投资金额，也不提交交易。
// @match        https://web3.okx.com/earn/product/uniswap-v3-x-layer-*-usdc-*
// @match        https://web3.okx.com/earn/product/uniswap-v3-x-layer-*-usdg-*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const ID = 'codex-okx-lp-range';
  if (document.getElementById(ID)) return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const number = text => Number(String(text ?? '').replace(/,/g, '').trim());
  const roundDown = value => Math.floor(value * 10000) / 10000;
  const roundUp = value => Math.ceil(value * 10000) / 10000;
  const minWidth = 8.01; // 严格超过 8%，给价格显示与取整留一点余量
  const maxWidth = 8.2; // 不把明显过宽的区间误报为成功

  function priceBox(label) {
    return [...document.querySelectorAll('div[class*="price-input-container"]')]
      .find(box => [...box.querySelectorAll('span')].some(span => span.textContent?.trim() === label));
  }

  function currentPrice() {
    const block = document.querySelector('div[class*="current-price"]');
    const row = block?.querySelector('[class*="price-row"]');
    // OKX 把数字和报价单位放在相邻 span，row.textContent 会变成
    // "153.4USDG per wICEx"，不能靠数字与 USDG 之间的单词边界判断。
    const quote = [...(row?.querySelectorAll('span') || [])]
      .map(span => span.textContent?.trim() || '')
      .find(text => /\s+per\s+/i.test(text));
    if (!/^(?:USDC|USDG)\s+per\s+\S+$/i.test(quote || '')) {
      throw new Error('当前报价不是稳定币 / 股票代币；已停止。');
    }
    for (const label of ['Min price', 'Max price']) {
      const units = [...(priceBox(label)?.querySelectorAll('span') || [])]
        .map(span => span.textContent?.trim() || '');
      if (!units.includes(quote)) throw new Error(`${label} 与现价的报价方向不一致；已停止。`);
    }
    const value = number(row?.querySelector('[class*="price-value"]')?.textContent);
    if (!(value > 0)) throw new Error('未找到有效现价，请等页面加载完成。');
    return value;
  }

  function rangeInput(label) {
    const input = priceBox(label)?.querySelector('input[inputmode="decimal"]');
    if (!input) throw new Error(`未找到 ${label} 输入框；OKX 页面结构可能已变化。`);
    return input;
  }

  async function setPrice(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value.toFixed(4));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value.toFixed(4) }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    await sleep(450); // 等待 OKX 按池子的 tick 调整价格
  }

  function actualRange(price) {
    const min = number(rangeInput('Min price').value);
    const max = number(rangeInput('Max price').value);
    if (!(min > 0 && min < price && max > price)) return null;
    return {
      min,
      max,
      below: (1 - min / price) * 100,
      above: (max / price - 1) * 100,
      width: ((max - min) / price) * 100,
    };
  }

  function matchesGoal(range) {
    return range && range.width > minWidth && range.width <= maxWidth
      && range.above > 0.2 && range.above < 0.3;
  }

  async function stepPrice(label, direction) {
    const control = priceBox(label)?.querySelector(`[aria-label="${direction}"]`);
    if (!control) throw new Error(`找不到 ${label} 的 ${direction} 按钮。`);
    control.click();
    await sleep(140);
  }

  async function alignUpper(price) {
    let lastDirection = '';
    for (let i = 0; i < 40; i++) {
      const max = number(rangeInput('Max price').value);
      if (!(max > 0)) return false;
      const above = (max / price - 1) * 100;
      if (above > 0.2 && above < 0.3) return true;
      const direction = above >= 0.3 ? 'Decrease' : 'Increase';
      // 一个档位跨过整个 0.2%～0.3% 窗口时，无法满足要求。
      if (lastDirection && direction !== lastDirection) return false;
      await stepPrice('Max price', direction);
      lastDirection = direction;
    }
    return false;
  }

  async function alignLower(price) {
    let range = actualRange(price);
    if (!range) return false;
    // 直接输入下限后，OKX 可能吸附到比目标低很多的档位。
    // 用页面按钮逐档逼近，保留宽度刚好超过 8.01% 的最后一档。
    if (range.width <= minWidth) {
      for (let i = 0; i < 80; i++) {
        const previousMin = range.min;
        await stepPrice('Min price', 'Decrease');
        range = actualRange(price);
        if (!range || range.min >= previousMin) return false;
        if (range.width > minWidth) return true;
      }
      return false;
    }
    for (let i = 0; i < 80; i++) {
      const previousMin = range.min;
      await stepPrice('Min price', 'Increase');
      const next = actualRange(price);
      if (!next || next.min <= previousMin) return false;
      if (next.width <= minWidth) {
        await stepPrice('Min price', 'Decrease');
        const restored = actualRange(price);
        return !!restored && restored.width > minWidth && restored.min <= previousMin;
      }
      range = next;
    }
    return false;
  }

  function zoomOutChart() {
    const control = document.querySelector('[role="button"][aria-label="zoomOut"]');
    if (!control) return false;
    control.click();
    return true;
  }

  const panel = document.createElement('div');
  panel.id = ID;
  panel.innerHTML = `
    <div class="codex-title">LP 区间快捷设置</div>
    <div class="codex-controls">
      <label>下方 <input id="codex-down" type="number" min="0.01" max="99" step="0.05" value="7.80">%</label>
      <label>上方 <input id="codex-up" type="number" min="0.01" max="99" step="0.05" value="0.25">%</label>
    </div>
    <button id="codex-apply" type="button">按当前价设置</button>
    <div id="codex-status" role="status">只改价格区间；请核对页面实际值。</div>
  `;
  const style = document.createElement('style');
  style.textContent = `
    #${ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:248px;padding:13px;
      color:#fff;background:#171717;border:1px solid #555;border-radius:10px;
      box-shadow:0 5px 24px #0008;font:13px/1.45 sans-serif}
    #${ID} .codex-title{font-weight:700;margin-bottom:8px}
    #${ID} .codex-controls{display:flex;gap:9px;margin-bottom:9px}
    #${ID} label{flex:1;white-space:nowrap}
    #${ID} input{width:48px;padding:4px;color:#fff;background:#292929;border:1px solid #777;border-radius:4px}
    #${ID} button{width:100%;padding:7px;background:#fff;color:#111;border:0;border-radius:5px;cursor:pointer;font-weight:700}
    #${ID} button:disabled{opacity:.55;cursor:wait}
    #${ID} [role=status]{margin-top:8px;color:#ccc;white-space:pre-line}
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  const status = panel.querySelector('#codex-status');
  const button = panel.querySelector('#codex-apply');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const down = number(panel.querySelector('#codex-down').value);
      const up = number(panel.querySelector('#codex-up').value);
      if (!(down > 0 && down < 99 && up > 0.2 && up < 0.3)) {
        throw new Error('下方必须大于 0%；上方请输入 0.2%～0.3% 之间的值。');
      }
      const price = currentPrice();
      const targetMin = roundDown(price * (1 - down / 100));
      const targetMax = roundUp(price * (1 + up / 100));
      status.textContent = `现价 ${price}；正在设置并校准价格档位…`;
      await setPrice(rangeInput('Min price'), targetMin);
      await setPrice(rangeInput('Max price'), targetMax);
      const upperAligned = await alignUpper(price);
      const lowerAligned = upperAligned && await alignLower(price);
      // 价格在操作期间可能变化；最终以页面此刻显示的现价再验一次。
      const actual = actualRange(currentPrice());
      const success = upperAligned && lowerAligned && matchesGoal(actual);
      if (!actual) throw new Error('页面没有接受有效区间。请手动检查价格框。');
      const zoomedOut = zoomOutChart();
      status.textContent = `页面实际：${actual.min} ～ ${actual.max}\n下方 ${actual.below.toFixed(2)}%，上方 ${actual.above.toFixed(2)}%；总宽度 ${actual.width.toFixed(2)}%。${success ? '\n✓ 满足脚本条件；请核对奖励规则后再申购。' : '\n⚠ 未达到“宽度 >8.01% 且 ≤8.20%、上方 0.2%～0.3%”；请手动调整，勿按此结果直接申购。'}${zoomedOut ? '' : '\n⚠ 未找到图表缩小按钮，请手动调整图表视野。'}`;
    } catch (error) {
      status.textContent = `⚠ ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
})();
