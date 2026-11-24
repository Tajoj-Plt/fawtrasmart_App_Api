import { Request, Response } from 'express';
import { z } from 'zod';
import { DeductionUseCases } from '../../../../application/use-cases/hr/DeductionUseCases';
import { DEDUCTION_STATUSES, DEDUCTION_TYPES } from '../../../../domain/services/hr/HrConstants';
import { currentUserId } from '../../middlewares/auth';
import { ok } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery } from '../clients/ClientsController';
import { hrMeta, pageInt, perPageInt, searchText } from './HrController';

const listSchema = z.object({
  page: pageInt.optional(),
  perPage: perPageInt.optional(),
  status: z.enum(DEDUCTION_STATUSES, { message: 'الحالة غير صالحة.' }).optional(),
  type: z.enum(DEDUCTION_TYPES, { message: 'نوع الخصمية غير صالح.' }).optional(),
  search: searchText,
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** الخصميات — `/hr/deductions` */
export class DeductionsController {
  constructor(private readonly deductions: DeductionUseCases) {}

  index = async (req: Request, res: Response) => {
    ok(res, await this.deductions.list(currentUserId(req), hrMeta(req, 'deductions.index'), parseQuery(listSchema, req.query)));
  };

  show = async (req: Request, res: Response) => {
    ok(res, await this.deductions.show(currentUserId(req), hrMeta(req, 'deductions.show'), idParam(req, 'id')));
  };
}
