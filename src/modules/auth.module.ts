import { Body, Controller, Get, Injectable, Module, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { AuditService } from '../common/common.service';

class LoginDto {
  @IsString() tenant!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(6) password!: string;
}
class RefreshDto {
  @IsString() refreshToken!: string;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService) {}

  private async buildSession(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { role: true } }, tenant: true },
    });
    const roles = [...new Set(user.memberships.map((m) => m.role.name))];
    const perms = [...new Set(user.memberships.flatMap((m) => (m.role.permissions as string[]) ?? []))];

    const accessToken = this.jwt.sign(
      { sub: user.id, tid: user.tenantId, name: user.name, email: user.email, roles, perms },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as any },
    );

    // Rotating refresh token — disimpan dalam bentuk hash
    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(process.env.REFRESH_TTL_DAYS ?? 7);
    await this.prisma.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + days * 86400_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        roles,
        perms,
        tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
      },
    };
  }

  async login(dto: LoginDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: dto.tenant.trim().toLowerCase() } });
    const invalid = new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Perusahaan, email atau password salah' });
    if (!tenant || tenant.status !== 'ACTIVE') throw invalid;
    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: dto.email.toLowerCase() } },
    });
    if (!user || !user.isActive || !user.passwordHash) throw invalid;
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw invalid;

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ tenantId: tenant.id, userId: user.id, name: user.name }, 'LOGIN', 'User', user.id);
    return this.buildSession(user.id);
  }

  async refresh(token: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH', message: 'Sesi berakhir, silakan login ulang' });
    }
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.buildSession(row.userId);
  }

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
}

@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('auth/logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('tenant')
  tenant(@CurrentUser() user: AuthUser) {
    return this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { companies: true },
    });
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
