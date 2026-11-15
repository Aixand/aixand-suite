import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Inject,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { cookieName, SESSION_LIFETIME } from './config.js';
import { loginPasswordSchema, passwordSchema } from './password.js';
import { onboardingSaveSchema } from './onboarding.js';

const setupSchema = z
  .object({
    password: passwordSchema,
    confirmation: z.string().max(512),
  })
  .strict()
  .refine(
    (value) => value.password === value.confirmation,
    'Passwords must match.',
  );
const loginSchema = z.object({ password: loginPasswordSchema }).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((issue) => issue.message).join(' '),
    );
  return result.data;
}
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('status')
  status(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.auth.assertTransport(request);
    return this.auth.status(request);
  }
  @Post('setup')
  async setup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.auth.assertMutation(request);
    const input = parse(setupSchema, body);
    const token = await this.auth.setup(request, input.password);
    this.setSessionCookie(request, response, token);
    return { authenticated: true };
  }
  @Post('login')
  async login(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    this.auth.assertMutation(request);
    const { password } = parse(loginSchema, body);
    const token = await this.auth.login(request, password);
    this.setSessionCookie(request, response, token);
    return { authenticated: true };
  }
  private setSessionCookie(
    request: Request,
    response: Response,
    token: string,
  ) {
    const name = cookieName(request);
    response.cookie(name, token, {
      httpOnly: true,
      secure: name.startsWith('__Host-'),
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_LIFETIME,
    });
  }
  @Get('session')
  session(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const session = this.auth.session(request);
    if (!session) throw new UnauthorizedException('Sign in required');
    const onboarding = this.auth.onboarding(request);
    return {
      authenticated: true,
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
      onboardingPending: onboarding?.status === 'pending',
      onboardingStep: onboarding?.step,
    };
  }
  @Get('onboarding')
  onboarding(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.auth.onboarding(request);
  }
  @Post('onboarding')
  saveOnboarding(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    response.setHeader('Cache-Control', 'no-store');
    this.auth.assertMutation(request);
    const input = parse(onboardingSaveSchema, body);
    return this.auth.saveOnboarding(request, input.progress, input.expectedRevision);
  }
  @Post('logout')
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.auth.assertMutation(request);
    this.auth.logout(request);
    const name = cookieName(request);
    response.clearCookie(name, {
      httpOnly: true,
      secure: name.startsWith('__Host-'),
      sameSite: 'strict',
      path: '/',
    });
    return { authenticated: false };
  }
}
