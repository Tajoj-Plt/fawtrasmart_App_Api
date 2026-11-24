import { AppError } from '../../../domain/errors/AppError';
import { UserRepository } from '../../../domain/repositories';
import { UserDTO } from '../../dto';
import { UserPresenter } from '../../services/UserPresenter';

export class GetCurrentUserUseCase {
  constructor(private readonly users: UserRepository, private readonly presenter: UserPresenter) {}

  async execute(userId: number): Promise<UserDTO> {
    const user = await this.users.findById(userId);
    if (!user) throw AppError.unauthorized('USER_NOT_FOUND', 'المستخدم غير موجود.');
    return this.presenter.present(user);
  }
}
