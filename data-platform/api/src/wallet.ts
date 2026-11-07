import { createHash } from "node:crypto";
import { unprocessable } from "./errors.ts";

/** Every Moonshot Wallet starts with $100,000 the first time it is used. */
export const WALLET_STARTING_BALANCE_MINOR = 10_000_000;

export type WalletId = { key: string; last4: string };

/** Standard Luhn check over the wallet's eight digits; the last digit is the check digit. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Parses `MSW-####-####`. Only a hash and the last four digits are ever stored. */
export function parseWalletId(input: string): WalletId {
  const match = /^MSW-(\d{4})-(\d{4})$/.exec(input.trim().toUpperCase());
  const digits = match ? match[1]! + match[2]! : "";
  if (!match || !luhnValid(digits)) {
    throw unprocessable("WALLET_INVALID", "Check your Moonshot Wallet ID. It looks like MSW-1234-5678.");
  }
  return { key: createHash("sha256").update(`moonshot-wallet:${digits}`).digest("hex"), last4: digits.slice(4) };
}
