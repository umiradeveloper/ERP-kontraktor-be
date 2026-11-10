import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

/** Konteks user terverifikasi. tenantId SELALU diambil dari token, bukan dari body request (PRD §9). */
export interface AuthUser {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  roles: string[];
  perms: string[];
}

export const IS_PUBLIC = 'isPublic';
export const PERMS = 'perms';

/** Endpoint tanpa autentikasi (login/refresh). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Permission yang dibutuhkan, mis. @Perm('procurement:write'). Deny-by-default. */
export const Perm = (...perms: string[]) => SetMetadata(PERMS, perms);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export function hasPerm(user: AuthUser, perm: string) {
  if (user.perms.includes('*')) return true;
  if (user.perms.includes(perm)) return true;
  // write mengimplikasikan read
  const [mod, action] = perm.split(':');
  if (action === 'read' && user.perms.includes(`${mod}:write`)) return true;
  return false;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Token tidak ditemukan');

    try {
      const payload = this.jwt.verify(header.slice(7), { secret: process.env.JWT_ACCESS_SECRET });
      req.user = {
        userId: payload.sub,
        tenantId: payload.tid,
        name: payload.name,
        email: payload.email,
        roles: payload.roles ?? [],
        perms: payload.perms ?? [],
      } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException('Sesi berakhir, silakan login ulang');
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMS, targets);
    if (!required || required.length === 0) {
      // Endpoint terautentikasi tanpa permission spesifik (mis. /me)
      return true;
    }
    if (!required.some((p) => hasPerm(req.user, p))) {
      throw new ForbiddenException('Anda tidak memiliki akses untuk aksi ini');
    }
    return true;
  }
}
