import { Request, Response } from 'express';
import { z } from 'zod';
import { PayslipUseCases } from '../../../../application/use-cases/hr/PayslipUseCases';
import { RUN_STAGES, SLIP_STATUSES } from '../../../../domain/services/hr/HrConstants';
import { currentUserId } from '../../middlewares/auth';
import { ok } from '../../respond';
import { calendarDate } from '../../schemas';
import { idParam, parseQuery } from '../clients/ClientsController';
import { hrMeta, pageInt, perPageInt, searchText } from './HrController';

const slipListSchema = z.object({
  page: pageInt.optional(),
  perPage: perPageInt.optional(),
  status: z.enum(SLIP_STATUSES, { message: 'الحالة غير صالحة.' }).optional(),
  search: searchText,
});

const runListSchema = z.object({
  page: pageInt.optional(),
  perPage: perPageInt.optional(),
  stage: z.enum(RUN_STAGES, { message: 'المرحلة غير صالحة.' }).optional(),
  search: searchText,
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** اتفاقُ الراتب وصرفاتُه الشهرية — `/hr/salary-slips` و`/hr/payslips` */
export class PayslipsController {
  constructor(private readonly payslips: PayslipUseCases) {}

  slips = async (req: Request, res: Response) => {
    ok(res, await this.payslips.slips(currentUserId(req), hrMeta(req, 'salary-slips.index'), parseQuery(slipListSchema, req.query)));
  };

  slip = async (req: Request, res: Response) => {
    ok(res, await this.payslips.slip(currentUserId(req), hrMeta(req, 'salary-slips.show'), idParam(req, 'id')));
  };

  runs = async (req: Request, res: Response) => {
    ok(res, await this.payslips.runs(currentUserId(req), hrMeta(req, 'payslips.index'), parseQuery(runListSchema, req.query)));
  };

  run = async (req: Request, res: Response) => {
    ok(res, await this.payslips.run(currentUserId(req), hrMeta(req, 'payslips.show'), idParam(req, 'id')));
  };
}
