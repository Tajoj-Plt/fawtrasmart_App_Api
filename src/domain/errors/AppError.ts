/**
 * خطأ تطبيقي موحَّد: رمز ثابت تترجمه الواجهة، وحالة HTTP، وتفاصيل اختيارية.
 * كل ما يُرمى من طبقة التطبيق يمرّ من هنا كي يبقى شكل الاستجابة واحداً.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation(details: unknown, message = 'Validation failed') {
    return new AppError('VALIDATION_ERROR', message, 422, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = 'Unauthenticated') {
    return new AppError(code, message, 401);
  }

  static forbidden(code = 'FORBIDDEN', message = 'Forbidden') {
    return new AppError(code, message, 403);
  }

  static notFound(code = 'NOT_FOUND', message = 'Not found') {
    return new AppError(code, message, 404);
  }
}
