import { Request, Response } from 'express';
import { GetLanguagesUseCase } from '../../../application/use-cases/settings/GetLanguagesUseCase';
import { GetThemeUseCase } from '../../../application/use-cases/settings/GetThemeUseCase';
import { ok } from '../respond';

export class SettingsController {
  constructor(private readonly theme: GetThemeUseCase, private readonly languages: GetLanguagesUseCase) {}

  themeHandler = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    ok(res, await this.theme.execute());
  };

  languagesHandler = async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    ok(res, await this.languages.execute());
  };
}
