/**
 * 用户通知占位函数。
 *
 * 目前不实现任何投递逻辑（短信/钉钉/Telegram 等后续再接），
 * 调用点已经按「通知内容 + 结构化字段」准备好，实现时只需填充本函数。
 */
export function notify(_message: string, _fields: Record<string, unknown> = {}): void {
  // TODO: 接入实际通知渠道。
}
