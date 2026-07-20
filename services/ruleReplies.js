export function getRuleReply(text, lead) {
  const message = text.trim().toLowerCase();

  if (!message) return null;

  if (message === "stop" || message === "unsubscribe" || message === "band" || message === "band karo") {
    return "Theek hai Sir, aapko further broadcast/update messages nahi bheje jayenge.\n\nDobara start karne ke liye START reply kar dijiye.";
  }

  if (message === "start" || message === "subscribe") {
    return "Done Sir, aapko important updates dobara mil sakte hain.";
  }

  if (lead?.optedOut) {
    return "Sir, aapne updates stop kiye hue hain.\n\nDobara start karne ke liye START reply kar dijiye.";
  }

  if (!lead.aiEnabled || lead.assignedTo) {
    return null;
  }

  return null;
}