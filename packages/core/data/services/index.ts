/**
 * @status core
 *
 * Generic service contracts only. Business-specific services belong to Client Experience.
 */
export interface EmailService {
  send(input: {
    to: string;
    subject: string;
    body: string;
  }): Promise<void>;
}
