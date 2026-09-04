export type HintType =
  | 'Task requirements'
  | 'Concepts'
  | 'Error correction'
  | 'Task processing steps';


export async function classifyHintType(
  code: string
): Promise<HintType> {

  // Temporary test:
  // always use Concepts prompt first
  return 'Concepts';
}


export function getPromptIdByHintType(
  hintType: HintType
): string {

  switch (hintType) {

    case 'Task requirements':
      return 'hint_task_requirements';

    case 'Concepts':
      return 'hint_concepts';

    case 'Error correction':
      return 'hint_error_correction';

    case 'Task processing steps':
      return 'hint_task_processing_steps';
  }
}