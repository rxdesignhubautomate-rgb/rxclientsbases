import nodemailer from "nodemailer";
import { AppError } from "../utils/errors.js";

export class OtpMailerService {
  constructor(env, transportFactory = nodemailer.createTransport) {
    this.env = env;
    this.transportFactory = transportFactory;
    this.transport = null;
  }

  configured() {
    return Boolean(
      this.env.OTP_LOGIN_ENABLED &&
      this.env.OTP_DELIVERY_EMAIL &&
      this.env.OTP_SMTP_USER &&
      this.env.OTP_SMTP_APP_PASSWORD
    );
  }

  async send({ loginEmail, code, expiresInMinutes }) {
    if (!this.configured()) {
      throw new AppError("OTP_NOT_CONFIGURED", "OTP login is not configured on the server", 503);
    }
    if (!this.transport) {
      this.transport = this.transportFactory({
        service: "gmail",
        auth: { user: this.env.OTP_SMTP_USER, pass: this.env.OTP_SMTP_APP_PASSWORD.replace(/\s/g, "") }
      });
    }
    await this.transport.sendMail({
      from: `RX Client CRM <${this.env.OTP_SMTP_USER}>`,
      to: this.env.OTP_DELIVERY_EMAIL,
      subject: `${code} is the RX Client CRM login code`,
      text: `Login ID: ${loginEmail}\nOTP: ${code}\nThis code expires in ${expiresInMinutes} minutes. If you did not request it, ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;color:#111b34"><h2>RX Client CRM login</h2><p>Login ID: <strong>${escapeHtml(loginEmail)}</strong></p><p style="font-size:30px;letter-spacing:7px;font-weight:700">${code}</p><p>This code expires in ${expiresInMinutes} minutes.</p><p style="color:#718096">If you did not request it, ignore this email.</p></div>`
    });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
