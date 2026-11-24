import { describe, expect, it } from 'vitest';
import { AppError } from '../src/domain/errors/AppError';
import { ACCOUNTING_FORMS } from '../src/domain/services/AccountingForms';
import { assertBridgeAvailable, interpretErpResult, mapErrorKeys } from '../src/application/use-cases/forms/GenericFormsUseCases';

describe('mapErrorKeys', () => {
  it('leaves keys untouched by default', () => {
    expect(mapErrorKeys({ amount: ['x'] })).toEqual({ amount: ['x'] });
  });

  it("the journal entry form's mapErrorKey strips journal_entry. and folds details into lines", () => {
    const mapKey = ACCOUNTING_FORMS.journal!.mapErrorKey!;
    expect(mapErrorKeys({ 'journal_entry.date': ['x'], 'details.0.debit': ['a'], details: ['b'] }, mapKey)).toEqual({ date: ['x'], lines: ['a', 'b'] });
  });
});

describe('interpretErpResult', () => {
  it('accepts 2xx', () => expect(interpretErpResult({ status: 201, body: { message: 'ok' } }).message).toBe('ok'));
  it('treats success:false 200 as validation failure', () => {
    expect(() => interpretErpResult({ status: 200, body: { success: false, errors: { a: ['b'] } } })).toThrow(AppError);
  });
  it('hides 5xx details', () => {
    try {
      interpretErpResult({ status: 500, body: { message: 'SQLSTATE secret' } });
    } catch (e) {
      expect((e as AppError).message).not.toContain('SQLSTATE');
    }
  });
  it('treats a business-rule redirect (message only, no field errors) as a validation failure with no field-level errors', () => {
    try {
      interpretErpResult({ status: 422, body: { success: false, message: 'حدث خطأ' } });
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as AppError).details).toEqual({});
      expect((e as AppError).message).toBe('حدث خطأ');
    }
  });
});

describe('assertBridgeAvailable', () => {
  const code = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as AppError).code;
    }
  };
  it('flags a missing api/mobile route (Laravel 404) as ERP_BRIDGE_UNAVAILABLE', () => {
    expect(code(() => assertBridgeAvailable({ status: 404, body: { message: 'The route api/mobile/accounting/forms/expenses/options could not be found.' } }))).toBe('ERP_BRIDGE_UNAVAILABLE');
  });
  it('flags a persistent 401 as ERP_BRIDGE_UNAVAILABLE', () => {
    expect(code(() => assertBridgeAvailable({ status: 401, body: { message: 'Unauthenticated.' } }))).toBe('ERP_BRIDGE_UNAVAILABLE');
  });
  it("lets the bridge's own 404 and normal responses through", () => {
    expect(code(() => assertBridgeAvailable({ status: 404, body: { message: 'نموذج غير معروف.' } }))).toBeNull();
    expect(code(() => assertBridgeAvailable({ status: 200, body: { success: true } }))).toBeNull();
  });
});
