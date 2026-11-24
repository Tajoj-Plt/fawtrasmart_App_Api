import { Request, RequestHandler, Response, Router } from 'express';
import { Container } from '../../../container';
import { AdvancesController } from '../controllers/hr/AdvancesController';
import { AttendanceController } from '../controllers/hr/AttendanceController';
import { DeductionsController } from '../controllers/hr/DeductionsController';
import { HrController } from '../controllers/hr/HrController';
import { PayslipsController } from '../controllers/hr/PayslipsController';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => fn(req, res).catch(next);

/**
 * الموارد البشرية — `/api/v1/hr/...`.
 * الاشتراكُ ومفتاحُ «المرتّبات» وميزةُ الباقة والصلاحيةُ ونطاقُ الموظفين تُفحص
 * في طبقة التطبيق (`HrContextFactory` و`HrAccess`) بترتيب وسطاء الويب؛ هنا المسارات فقط.
 */
export function hrRoutes(c: Container, auth: RequestHandler): Router {
  const router = Router();
  const hr = new HrController(c.useCases.hr);
  const advances = new AdvancesController(c.useCases.hrAdvances);
  const deductions = new DeductionsController(c.useCases.hrDeductions);
  const payslips = new PayslipsController(c.useCases.hrPayslips);
  const attendance = new AttendanceController(c.useCases.hrAttendance);

  // ---- عامّ ----
  router.get('/hr/sections', auth, wrap(hr.sections));
  router.get('/hr/overview', auth, wrap(hr.overview));

  // ---- «سجّل حضوري»: حضور وانصراف واستراحة بالموقع — قواعد الويب عبر الجسر ----
  router.get('/hr/attendance', auth, wrap(attendance.state));
  router.post('/hr/attendance/check-in', auth, wrap(attendance.checkIn));
  router.post('/hr/attendance/check-out', auth, wrap(attendance.checkOut));
  router.post('/hr/attendance/break', auth, wrap(attendance.toggleBreak));

  // ---- السلف (القراءة للنظامين، والكتابةُ طلبٌ وسحبُه فقط) ----
  // `create-data` قبل `:id` كي لا يُقرأ اسمُها معرّفاً
  router.get('/hr/advances', auth, wrap(advances.index));
  router.get('/hr/advances/create-data', auth, wrap(advances.createData));
  router.get('/hr/advances/:id', auth, wrap(advances.show));
  router.post('/hr/advances', auth, wrap(advances.store));
  router.post('/hr/advances/:id/withdraw', auth, wrap(advances.withdraw));

  // ---- الخصميات (عرضٌ فقط) ----
  router.get('/hr/deductions', auth, wrap(deductions.index));
  router.get('/hr/deductions/:id', auth, wrap(deductions.show));

  // ---- اتفاق الراتب (عرضٌ فقط) ----
  router.get('/hr/salary-slips', auth, wrap(payslips.slips));
  router.get('/hr/salary-slips/:id', auth, wrap(payslips.slip));

  // ---- الصرفة الشهرية (عرضٌ فقط) ----
  router.get('/hr/payslips', auth, wrap(payslips.runs));
  router.get('/hr/payslips/:id', auth, wrap(payslips.run));

  return router;
}
