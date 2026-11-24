import { SettingsRepository } from '../../../domain/repositories';
import { buildTheme, ThemeDTO } from '../../../domain/services/ThemePalette';
import { Cache } from '../../ports';

export class GetThemeUseCase {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly cache: Cache,
    private readonly ttl: number,
    private readonly publicUrl: string,
  ) {}

  execute(): Promise<ThemeDTO> {
    return this.cache.wrap('settings:theme', this.ttl, async () => buildTheme(await this.settings.theme(), this.publicUrl));
  }
}
