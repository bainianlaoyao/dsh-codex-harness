/** Keep a native DSH tool batch together before lifting its images into a user
 * multimodal message. Accept both 0.1 wrapped and 0.2 direct tool results. */
export function toolBatches(messages) {
  const result = []
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) { result.push(message); continue }
    const block = { type: 'tool-result', toolCallId: message.toolCallId, content: message.content, isError: message.isError }
    const previous = result.at(-1)
    if (previous?.toolBatch) previous.content.push(block)
    else result.push({ role: 'user', toolBatch: true, content: [block] })
  }
  return result
}
