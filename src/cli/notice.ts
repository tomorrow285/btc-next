#!/usr/bin/env node
/**
 * 飞书通知自检 / 手动推送。
 *
 *   pnpm notice "要发送的内容"   # 发一条真实消息
 *   pnpm notice --check          # 只检查凭据是否齐全，不发送
 *
 * 执行器自己不会在启动时发消息；要验证链路，用这个命令。
 */
import { config } from "../config/env.js";
import { notify } from "../engine/notify.js";

const args = process.argv.slice(2);

if (args[0] === "--check") {
  if (config.feishu.enabled) {
    console.log(`✅ 飞书通知已启用（receive_id_type=${config.feishu.receiveIdType}）`);
  } else {
    console.error(
      "⚠️ 飞书通知未启用：在 .env 填写 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID" +
        "（或检查 FEISHU_NOTIFY_ENABLED 是否为 false）",
    );
    process.exit(1);
  }
} else {
  if (!config.feishu.enabled) {
    console.error(
      "⚠️ 飞书通知未启用：在 .env 填写 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID",
    );
    process.exit(1);
  }

  const text = args.join(" ").trim() || "🔧【自检】btc-next 飞书通知链路正常。";
  const sent = await notify(text, { scope: "cli_notice" });

  if (sent) {
    console.log("✅ 已推送到飞书");
  } else {
    // 具体原因在 stdout 的 notice_failed JSON 日志里（重试次数 / 错误码）。
    console.error("❌ 推送失败，见上方 notice_failed 日志");
    process.exit(1);
  }
}
