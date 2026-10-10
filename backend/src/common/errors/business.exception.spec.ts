import { HttpStatus } from '@nestjs/common';
import { BusinessException } from './business.exception';
import { ErrorCode } from './error-code';

describe('BusinessException', () => {
  it('仅传错误码时，HTTP 状态码与中文文案由错误码推导', () => {
    const error = new BusinessException(ErrorCode.TEST_SESSION_EXPIRED);

    expect(error.code).toBe(ErrorCode.TEST_SESSION_EXPIRED);
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.userMessage).toBe('测试已超时，请重新开始');
  });

  it('自定义文案优先级高于错误码默认文案', () => {
    const error = new BusinessException(ErrorCode.TEST_ANSWER_INCOMPLETE, '还有 3 道题未作答');

    expect(error.userMessage).toBe('还有 3 道题未作答');
    expect(error.code).toBe(ErrorCode.TEST_ANSWER_INCOMPLETE);
  });

  it('响应体结构符合统一错误契约', () => {
    const error = new BusinessException(ErrorCode.PARAM_INVALID, '请求参数不合法', {
      details: [{ field: 'page', issue: 'page 必须是整数' }],
    });

    expect(error.getResponse()).toEqual({
      code: ErrorCode.PARAM_INVALID,
      message: '请求参数不合法',
      details: [{ field: 'page', issue: 'page 必须是整数' }],
    });
  });

  describe('静态工厂', () => {
    it('badRequest → 400', () => {
      const error = BusinessException.badRequest();
      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(error.code).toBe(ErrorCode.PARAM_INVALID);
    });

    it('notFound → 404', () => {
      const error = BusinessException.notFound(ErrorCode.AI_REPORT_NOT_FOUND);
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('forbidden → 403', () => {
      const error = BusinessException.forbidden(ErrorCode.TEST_SESSION_NOT_OWNED);
      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    });

    it('tooManyRequests → 429', () => {
      const error = BusinessException.tooManyRequests();
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('unavailable → 503，且携带日志上下文', () => {
      const error = BusinessException.unavailable(ErrorCode.AI_PROVIDER_UNAVAILABLE);
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('internal → 500，logContext 不透出到响应体', () => {
      const error = BusinessException.internal(ErrorCode.INTERNAL_ERROR, '服务异常', {
        provider: 'deepseek',
        rawError: 'connect ETIMEDOUT',
      });

      expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(error.logContext).toEqual({ provider: 'deepseek', rawError: 'connect ETIMEDOUT' });
      expect(JSON.stringify(error.getResponse())).not.toContain('ETIMEDOUT');
    });
  });
});
