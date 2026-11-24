import { Request, Response } from 'express';
import { GetHomeModulesUseCase } from '../../../application/use-cases/home/GetHomeModulesUseCase';
import { currentUserId } from '../middlewares/auth';
import { ok } from '../respond';

export class HomeController {
  constructor(private readonly modules: GetHomeModulesUseCase) {}

  modulesHandler = async (req: Request, res: Response) => {
    ok(res, await this.modules.execute(currentUserId(req)));
  };
}
