import { Request, RequestHandler, Response, Router } from 'express';
import { Container } from '../../../container';
import { PermitsController } from '../controllers/stock/PermitsController';
import { PriceListsController } from '../controllers/stock/PriceListsController';
import { WarehousesController } from '../controllers/stock/WarehousesController';
import { upload } from './clients';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => fn(req, res).catch(next);

/**
 * المخزون — `/api/v1/stock/...`.
 * الاشتراك ومفتاح «إدارة المخزون» وميزة الباقة والصلاحية ونطاق المستودعات تُفحص
 * في طبقة التطبيق (`StockContextFactory`) بترتيب وسطاء الويب؛ هنا المسارات فقط.
 */
export function stockRoutes(c: Container, auth: RequestHandler): Router {
  const router = Router();
  const wh = new WarehousesController(c.useCases.stockWarehouses);
  const permits = new PermitsController(c.useCases.stockPermits, c.useCases.stockPermitApprovals);
  const prices = new PriceListsController(c.useCases.stockPriceLists);

  // ---- المستودعات (عرض فقط) ----
  router.get('/stock/warehouses', auth, wrap(wh.index));
  router.get('/stock/warehouses/:id', auth, wrap(wh.show));
  router.get('/stock/warehouses/:id/movements', auth, wrap(wh.movements));

  // ---- الأذون المخزنية ----
  router.get('/stock/permits', auth, wrap(permits.index));
  router.get('/stock/permits/create-data', auth, wrap(permits.createData));
  router.get('/stock/permits/product-stock/:warehouseId/:productId', auth, wrap(permits.productStock));
  router.get('/stock/permits/:id', auth, wrap(permits.show));
  router.post('/stock/permits', auth, upload, wrap(permits.store));
  router.post('/stock/permits/:id', auth, upload, wrap(permits.update));
  router.put('/stock/permits/:id', auth, upload, wrap(permits.update));
  router.delete('/stock/permits/:id', auth, wrap(permits.destroy));
  router.post('/stock/permits/:id/reject', auth, wrap(permits.reject));
  router.post('/stock/permits/:id/approve', auth, wrap(permits.approve));
  router.post('/stock/permits/:id/cancel-approval', auth, wrap(permits.cancelApproval));

  // ---- قوائم الأسعار ----
  router.get('/stock/price-lists', auth, wrap(prices.index));
  router.get('/stock/price-lists/:id', auth, wrap(prices.show));
  router.post('/stock/price-lists', auth, wrap(prices.store));
  router.put('/stock/price-lists/:id', auth, wrap(prices.update));
  router.delete('/stock/price-lists/:id', auth, wrap(prices.destroy));
  router.post('/stock/price-lists/:id/products', auth, wrap(prices.addProduct));
  router.delete('/stock/price-lists/products/:itemId', auth, wrap(prices.removeProduct));

  // ---- الكشف المخزني ----
  router.get('/stock/statement/warehouses', auth, wrap(wh.statementWarehouses));
  router.get('/stock/statement', auth, wrap(wh.statement));

  return router;
}
