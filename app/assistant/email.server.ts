/**
 * Sending email. The app sends very little: one message to a shopper who
 * asked to hear when a sold-out product is back.
 *
 * Shopify gives apps no way to send email, so the app uses an email service
 * of its own over SMTP, which every provider speaks. It is configured with
 * environment variables (see .env.example); without them nothing is sent and
 * the features that need email stay switched off.
 *
 * Addresses and message bodies are never logged.
 */
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Shown as the sender's name, in front of the app's own address. */
  fromName?: string;
  /** Where a reply goes: the store, not the app. */
  replyTo?: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

export interface EmailStatus {
  ready: boolean;
  /** What is missing, in words for the person running the app. */
  problem: string | null;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | string {
  const host = env.SMTP_HOST?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!host) return "SMTP_HOST is not set";
  if (!from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) {
    return "EMAIL_FROM is not set to an email address";
  }
  const port = Number(env.SMTP_PORT) || 587;
  return {
    host,
    port,
    // Port 465 speaks TLS from the first byte; the others upgrade with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    user: env.SMTP_USER?.trim() ?? "",
    password: env.SMTP_PASSWORD ?? "",
    from,
  };
}

/** Whether email can be sent, and what is missing when it cannot. */
export function getEmailStatus(env: NodeJS.ProcessEnv = process.env): EmailStatus {
  const config = readConfig(env);
  return typeof config === "string"
    ? { ready: false, problem: config }
    : { ready: true, problem: null };
}

/** A display name with nothing in it that could end the header early. */
const headerName = (name: string) => name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 80);

let transport: { key: string; send: ReturnType<typeof nodemailer.createTransport> } | null = null;

/** Sends one message through the configured SMTP service. Rejects when it could not be sent. */
export const sendEmail: EmailSender = async (message) => {
  const config = readConfig();
  if (typeof config === "string") throw new Error("email is not configured");

  // One connection pool for as long as the settings stay the same.
  const key = `${config.host}:${config.port}:${config.user}:${config.secure}`;
  if (!transport || transport.key !== key) {
    transport = {
      key,
      send: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.password } : undefined,
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
      }),
    };
  }

  const name = message.fromName ? headerName(message.fromName) : "";
  await transport.send.sendMail({
    from: name ? `"${name}" <${config.from}>` : config.from,
    to: message.to,
    replyTo: message.replyTo || undefined,
    subject: message.subject.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: message.text,
    html: message.html,
  });
};
