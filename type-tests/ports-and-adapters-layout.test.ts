import type { PortableRuntimePorts } from '../src/ports/portable-runtime.js';
import type { ProjectAdvanceRuntimeHost } from '../src/ports/project-advance-runtime-host.js';
import type { ProductionPromotionRuntimeHost } from '../src/ports/production-promotion-runtime-host.js';
import { createNodePostgresRuntime } from '../src/adapters/postgres/node-postgres-runtime.js';
import { createProjectAdvancePorts } from '../src/adapters/project-advance/runtime-adapter.js';
import { createProductionPromotionPorts } from '../src/adapters/production-promotion/runtime-adapter.js';
import { createProjectAdvanceMcpBinding } from '../src/adapters/mcp/project-advance.js';
import { createProjectInspectMcpBinding } from '../src/adapters/mcp/project-inspect.js';
import { createProductionPromotionMcpBinding } from '../src/adapters/mcp/production-promotion.js';

void (null as unknown as PortableRuntimePorts);
void (null as unknown as ProjectAdvanceRuntimeHost);
void (null as unknown as ProductionPromotionRuntimeHost);
void createNodePostgresRuntime;
void createProjectAdvancePorts;
void createProductionPromotionPorts;
void createProjectAdvanceMcpBinding;
void createProjectInspectMcpBinding;
void createProductionPromotionMcpBinding;