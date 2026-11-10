import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { readFileSync } from 'fs';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
  /** Jika diisi, notifikasi yang sama tidak dikirim dua kali ke user yang sama */
  dedupeKey?: string;
}

/**
 * Notifikasi in-app + email opsional (PRD §5.14).
 * Email dikirim hanya jika SMTP_HOST di-set; kegagalan email tidak menggagalkan transaksi.
 */
@Injectable()
export class NotifyService {
  private logger = new Logger('Notify');
  private mailer = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : null;

  constructor(private prisma: PrismaService) {}

  async toUsers(tenantId: string, userIds: string[], n: NotifyInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const created: string[] = [];
    for (const userId of ids) {
      if (n.dedupeKey) {
        const exists = await db.notification.findUnique({ where: { tenantId_userId_dedupeKey: { tenantId, userId, dedupeKey: n.dedupeKey } } });
        if (exists) continue;
      }
      await db.notification.create({ data: { tenantId, userId, type: n.type, title: n.title, body: n.body, link: n.link, dedupeKey: n.dedupeKey } });
      created.push(userId);
    }
    if (created.length) this.push(db, tenantId, created, n);
    if (this.mailer && created.length) {
      const users = await db.user.findMany({ where: { tenantId, id: { in: created }, isActive: true }, select: { email: true } });
      const base = process.env.WEB_ORIGIN?.split(',')[0] ?? '';
      // Kirim setelah transaksi; jangan blok request
      setImmediate(() => {
        for (const u of users) {
          this.mailer!
            .sendMail({
              from: process.env.SMTP_FROM ?? 'Kontrak ERP <no-reply@localhost>',
              to: u.email,
              subject: n.title,
              text: `${n.body ?? ''}\n\n${n.link ? base + n.link : ''}`.trim(),
            })
            .catch((e) => this.logger.warn(`Email gagal ke ${u.email}: ${e.message}`));
        }
      });
    }
  }

  /**
   * Push ke aplikasi mobile via Firebase Cloud Messaging (Android & iOS).
   * Aktif bila FIREBASE_SERVICE_ACCOUNT berisi path file service-account JSON (atau JSON-nya langsung).
   * Token yang sudah tidak valid dihapus otomatis. Deep link dikirim di data.link.
   */
  private fcm: Messaging | null | undefined;
  private messaging() {
    if (this.fcm !== undefined) return this.fcm;
    const cfg = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!cfg || process.env.DISABLE_PUSH === 'true') return (this.fcm = null);
    try {
      const cred = cfg.trim().startsWith('{') ? JSON.parse(cfg) : JSON.parse(readFileSync(cfg, 'utf8'));
      const app = getApps()[0] ?? initializeApp({ credential: cert(cred) });
      this.fcm = getMessaging(app);
    } catch (e) {
      this.logger.warn(`FCM tidak aktif: ${(e as Error).message}`);
      this.fcm = null;
    }
    return this.fcm;
  }

  private async push(db: Tx | PrismaService, tenantId: string, userIds: string[], n: NotifyInput) {
    const fcm = this.messaging();
    if (!fcm) return;
    const rows = await db.devicePushToken.findMany({ where: { tenantId, userId: { in: userIds } }, select: { token: true } });
    if (!rows.length) return;
    const tokens = rows.map((r) => r.token);
    setImmediate(async () => {
      try {
        const res = await fcm.sendEachForMulticast({
          tokens,
          notification: { title: n.title, body: n.body },
          data: { link: n.link ?? '', type: n.type },
          android: { priority: 'high', notification: { channelId: 'default', color: '#F2B705' } },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        const dead = res.responses
          .map((r, i) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null))
          .filter((t): t is string => !!t);
        if (dead.length) await this.prisma.devicePushToken.deleteMany({ where: { token: { in: dead } } });
      } catch (e) {
        this.logger.warn(`Push gagal: ${(e as Error).message}`);
      }
    });
  }

  /** Kirim ke semua user aktif yang memegang role tertentu, kecuali user yang dikecualikan */
  async toRoles(tenantId: string, roleNames: string[], n: NotifyInput, opts: { exclude?: string[]; tx?: Tx } = {}) {
    const db = opts.tx ?? this.prisma;
    const members = await db.membership.findMany({
      where: { tenantId, role: { name: { in: roleNames } }, user: { isActive: true } },
      select: { userId: true },
    });
    const ids = members.map((m) => m.userId).filter((id) => !opts.exclude?.includes(id));
    await this.toUsers(tenantId, ids, n, opts.tx);
  }
}
