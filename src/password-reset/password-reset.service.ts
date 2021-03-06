import { hash } from 'argon2';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { DateTime } from 'luxon';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MailerService } from '@nest-modules/mailer';
import { MessageResponse } from '../shared';
import { ForgotPasswordDto, ResetPasswordDto, QueryDto } from './dto';
import { UserEntity } from '../user/user.entity';
import { PasswordResetEntity } from './password-reset.entity';

@Injectable()
export class PasswordResetService {
  constructor(
    @InjectRepository(UserEntity) private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(PasswordResetEntity) private readonly passwordResetRepository: Repository<PasswordResetEntity>,
    private readonly configService: ConfigService,
    private readonly mailerService: MailerService,
  ) {}

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<MessageResponse> {
    const { email } = forgotPasswordDto;

    const user = await this.userRepository.findOne({ email });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const token = this.plaintextToken();

    const reset = new PasswordResetEntity();
    reset.user = user;
    reset.token = this.hashedToken(token);

    let savedReset: PasswordResetEntity;

    try {
      savedReset = await this.passwordResetRepository.save(reset);
    } catch (err) {
      if (err.code === '23505') {
        throw new ConflictException('Password reset email has already been sent');
      } else {
        throw new InternalServerErrorException();
      }
    }

    await this.mailerService.sendMail({
      to: email,
      subject: 'Reset your password',
      text: this.url(savedReset.id, token),
    });

    return { message: `Email sent to ${user.email}` };
  }

  async resetPassword(query: QueryDto, resetPasswordDto: ResetPasswordDto) {
    const { id, token } = query;
    const { password } = resetPasswordDto;

    const reset = await this.passwordResetRepository.findOne(id);
    let user: UserEntity | undefined;

    if (
      !reset ||
      !this.isResetValid(token, reset) ||
      !(user = await this.userRepository
        .createQueryBuilder('users')
        .where('users.id = :userId', { userId: reset.user.id })
        .andWhere('users.deletedAt IS NULL')
        .addSelect('users.password')
        .getOne())
    ) {
      throw new BadRequestException('Invalid password reset token');
    }

    const [res] = await Promise.all([
      this.resetUserPassword(user, password),
      this.passwordResetRepository
        .createQueryBuilder('passwordreset')
        .where('"passwordreset"."userId" = :userId', { userId: reset.user.id })
        .delete(),
    ]);

    await this.mailerService.sendMail({
      to: user.email,
      subject: 'Password reset',
      text: 'Your password was successfully reset',
    });

    return { message: res.message };
  }

  private async resetUserPassword(user: UserEntity, password: string): Promise<MessageResponse> {
    user.password = await hash(password);

    await this.userRepository.save(user);

    return { message: 'Password reset successfully' };
  }

  private plaintextToken(): string {
    return randomBytes(32).toString('hex');
  }

  private url(resetId: number, plaintextToken: string): string {
    const host = this.configService.get<string>('host');
    return `${host}/password/reset?id=${resetId}&token=${plaintextToken}`;
  }

  private hashedToken(plaintextToken: string): string {
    /* eslint-disable-next-line @typescript-eslint/no-non-null-assertion */
    return createHmac('sha256', this.configService.get<string>('hmacSecret')!)
      .update(plaintextToken)
      .digest('hex');
  }

  private isResetValid(plaintextToken: string, reset: PasswordResetEntity): boolean {
    const hash = this.hashedToken(plaintextToken);

    const { token, expiredAt } = reset;

    return timingSafeEqual(Buffer.from(hash), Buffer.from(token)) && expiredAt > DateTime.local().toString();
  }
}
