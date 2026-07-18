// Stub: @plures/praxis/core is from the praxis monorepo workspace.
// These minimal declarations allow compilation in CI.

export declare class PraxisRegistry<S = any> {
  register(module: any): void;
  registerModule(module: any): void;
  getModules(): any[];
}

export declare function createPraxisEngine<S = any>(config: any): LogicEngine<S>;

export declare function defineModule<S = any>(config: any): any;
export interface RuleState<S = any> {
  context: S;
  [key: string]: any;
}
export interface RuleConfig<S = any> {
  impl?: (state: RuleState<S>) => any;
  [key: string]: any;
}
export declare function defineRule<S = any>(config: RuleConfig<S>): any;
export declare function defineConstraint<S = any>(config: RuleConfig<S>): any;
export declare function defineContract<S = any>(config: any): any;
export declare function fact<T = any>(tag: string, payload?: T): any;

export declare const RuleResult: {
  pass(): any;
  fail(violations: string | string[]): any;
  emit(facts: any[]): any;
  skip(reason?: string): any;
  noop(reason?: string): any;
  [key: string]: (...args: any[]) => any;
};

export type LogicEngine<S = any> = {
  register(module: any): void;
  evaluate(state: any): any[];
  step(state: any): any;
  updateContext(updater: (ctx: S) => S): void;
  [key: string]: any;
};
