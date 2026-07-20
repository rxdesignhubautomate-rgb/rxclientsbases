export function normalizePhone(value, { defaultCountryCode = "91" } = {}) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10 && /^[6-9]/.test(digits)) digits = `${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith("0") && /^[6-9]/.test(digits.slice(1))) {
    digits = `${defaultCountryCode}${digits.slice(1)}`;
  }
  if (digits.startsWith("91") && digits.length === 12 && /^[6-9]/.test(digits.slice(2))) return digits;
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith("0")) return digits;
  return null;
}

export function phoneKey(orgId, phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `${orgId}:${normalized}` : null;
}
