import browser from 'webextension-polyfill';
import { isWhitespace, parseJSON } from '@/utils/helper';
import decryptFlow, { getWorkflowPass } from '@/utils/decryptFlow';
import convertWorkflowData from '@/utils/convertWorkflowData';
import WorkflowEngine from '../engine';

function workflowListener(workflow, options) {
  return new Promise((resolve, reject) => {
    if (workflow.isProtected) {
      const flow = parseJSON(workflow.drawflow, null);

      if (!flow) {
        const pass = getWorkflowPass(workflow.pass);

        workflow.drawflow = decryptFlow(workflow, pass);
      }
    }

    const engine = new WorkflowEngine(workflow, options);
    engine.init();
    engine.on('destroyed', ({ id, status, message }) => {
      options.events.onDestroyed(engine);

      if (status === 'error') {
        const error = new Error(message);
        error.data = { logId: id };

        reject(error);
        return;
      }

      resolve({ id, status, message });
    });

    options.events.onInit(engine);
  });
}

async function executeWorkflow({ id: blockId, data }) {
  if (data.workflowId === '') throw new Error('empty-workflow');

  const { workflows } = await browser.storage.local.get('workflows');
  let workflow = Array.isArray(workflows)
    ? workflows.find(({ id }) => id === data.workflowId)
    : workflows[data.workflowId];
  if (!workflow) {
    const errorInstance = new Error('no-workflow');
    errorInstance.data = { workflowId: data.workflowId };

    throw errorInstance;
  }

  workflow = convertWorkflowData(workflow);
  const optionsParams = { variables: {} };

  if (!isWhitespace(data.globalData))
    optionsParams.globalData = data.globalData;

  if (data.insertAllVars) {
    optionsParams.variables = JSON.parse(
      JSON.stringify(this.engine.referenceData.variables)
    );
  } else if (data.insertVars) {
    const varsName = data.insertVars.split(',');
    varsName.forEach((name) => {
      const varName = name.trim();
      const value = this.engine.referenceData.variables[varName];

      if (!value && typeof value !== 'boolean') return;

      optionsParams.variables[varName] = value;
    });
  }

  const options = {
    options: {
      data: optionsParams,
      parentWorkflow: {
        id: this.engine.id,
        name: this.engine.workflow.name,
      },
    },
    events: {
      onInit: (engine) => {
        this.childWorkflowId = engine.id;
      },
      onDestroyed: (engine) => {
        if (data.executeId) {
          const { dataColumns, globalData, googleSheets, table } =
            engine.referenceData;

          this.engine.referenceData.workflow[data.executeId] = {
            globalData,
            dataColumns,
            googleSheets,
            table: table || dataColumns,
          };
        }
      },
    },
    states: this.engine.states,
    logger: this.engine.logger,
    blocksHandler: this.engine.blocksHandler,
  };

  const isWorkflowIncluded = workflow.drawflow.nodes.some(
    (node) =>
      node.label === 'execute-workflow' &&
      node.data.workflowId === this.engine.workflow.id
  );
  if (isWorkflowIncluded) {
    throw new Error('workflow-infinite-loop');
  }

  const result = await workflowListener(workflow, options);

  return {
    data: '',
    logId: result.id,
    nextBlockId: this.getBlockConnections(blockId),
  };
}

export default executeWorkflow;
