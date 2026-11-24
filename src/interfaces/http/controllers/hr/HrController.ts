import { Request, Response } from 'express';
import { z } from 'zod';
import { HrUseCases } from '../../../../application/use-cases/hr/HrUseCases';
import { currentUserId } from '../../middlewares/auth';
import { ok } from '../../respond';
import { requestMeta } from '../clients/ClientsController';

/** ما يُكتب في السجلّ عن طلبات الموارد البشرية — `api.hr.<route>` */
export const hrMeta = (req: Request, route: string) => requestMeta(req, route, 'hr');

export const pageInt = z.coerce.number({ message: 'يجب أن يكون رقماً.' }).int('يجب أن يكون عدداً صحيحاً.').min(1, 'يجب ألّا يقلّ عن 1.');
export const perPageInt = pageInt.max(100, 'يجب ألّا يزيد على 100.');
export const searchText = z.string().trim().max(100).optional();
export const boolFlag = z.enum(['1', '0', 'true', 'false', 'on', 'off']).transform((v) => ['1', 'true', 'on'].includes(v));

/** أقسام الموارد البشرية و«نظرة عامة» — `/hr/sections` و`/hr/overview` */
export class HrController {
  constructor(private readonly hr: HrUseCases) {}

  sections = async (req: Request, res: Response) => {
    ok(res, await this.hr.sections(currentUserId(req)));
  };

  overview = async (req: Request, res: Response) => {
    ok(res, await this.hr.overview(currentUserId(req), hrMeta(req, 'overview')));
  };
}
