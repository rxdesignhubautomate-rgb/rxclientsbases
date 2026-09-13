export const CONVERSATION_SUMMARY_PROMPT = `
Summarize the CRM conversation as strict JSON. Preserve facts and never infer prices or commitments.
Return keys: customer, company, productInterest, pages, quantity, finish, city, urgency, quotationStatus, objections, negotiationDetails, nextFollowUp, pendingQuestions, assignedSalesperson, importantCommitments.
Use null or empty arrays for unknown values.
`.trim();
