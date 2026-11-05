#!/usr/bin/env node
/**
 * 恢复交易：清掉暂停标记。执行器下一个循环就会重新开始下单。
 *
 *   pnpm resume
 */
import { clearPause, readPause } from "../engine/pause.js";

const pause = readPause();
if (!pause) {
  console.log("本来就没在暂停状态，无事发生");
} else {
  console.log(`清除暂停标记（原因：${pause.reason}）`);
  clearPause();
  console.log("▶️ 已恢复交易");
}
