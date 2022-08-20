import {Construct} from 'constructs';
import {HttpMethod} from "aws-cdk-lib/aws-events";
import {AttributeType, BillingMode, ProjectionType} from "aws-cdk-lib/aws-dynamodb";
import {
  AwsIntegration,
  EndpointType,
  JsonSchemaType,
  MethodResponse,
  Model,
  PassthroughBehavior,
  RequestValidator
} from "aws-cdk-lib/aws-apigateway";
import {aws_apigateway, aws_dynamodb, aws_iam, Stack, StackProps} from 'aws-cdk-lib';

export class TodoAppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Decisions & Assumptions:
    // I could've proxied the requests to a lambda and used that to interact with dynamodb
    // but given the use-case that we want it to be scalable that's added overhead when I can
    // achieve the same with just the API GW itself, minus the cold start times,
    // added integration latencies and added cost.
    //
    // Standard dynamodb table class is used because the nature of the problem at hand automatically
    // removes IA table class.
    //
    // Due to unknown traffic on-demand capacity mode is utilized, once we get enough data about traffic
    // load patterns then we can switch to provisioned capacity along with auto-scaling to reduce cost
    // while achieving the same results.

    // possible improvements (skipped to save time):
    // * Could split whole stack into nested stacks.
    // * For all the incoming input $util.escapeJavaScript could be utilized to sanitize the input
    // * Assumption is made that DAX cluster is used for bulk reads of todos

    const apiGateway = new aws_apigateway.RestApi(this, 'rest-api-gateway', {
      restApiName: 'todo-api',
      deploy: true,
      endpointConfiguration: {
        types: [ EndpointType.REGIONAL ]
      }
    });

    const requestBodyValidator = new RequestValidator(this, 'request-body-validator', {
      restApi: apiGateway,
      requestValidatorName: 'Body Validatory',
      validateRequestBody: true,
      validateRequestParameters: false
    });

    const todoModel = new Model(this, 'todo-model', {
      restApi: apiGateway,
      modelName: 'Todo',
      schema: {
        type: JsonSchemaType.OBJECT,
        properties: {
          id: {
            type: JsonSchemaType.STRING,

          },
          title: {
            type: JsonSchemaType.STRING
          },
          description: {
            type: JsonSchemaType.STRING,
          }
        },
        required: [ "id", "title", "description" ]
      }
    });

    // possible improvement to have multiple integration roles for different HTTP Verbs
    const integrationRole = new aws_iam.Role(this, 'api-gw-dynamodb-role', {
      roleName: 'grant-apigateway-access-to-dynamodb',
      assumedBy: new aws_iam.ServicePrincipal('apigateway.amazonaws.com')
    });

    const tableName = 'todos';

    const dynamodb = new aws_dynamodb.Table(this, 'todos-table', {
      tableName,
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST
    });

    // would've been useful for title searches, but given no
    // api exists for it, we can skip it
    // dynamodb.addLocalSecondaryIndex({
    //   indexName: 'titleIndex',
    //   sortKey: { name: 'title', type: AttributeType.STRING },
    //   projectionType: ProjectionType.ALL
    // });

    dynamodb.grantFullAccess(integrationRole);

    const v1 = apiGateway.root.addResource('v1');

    const todo = v1.addResource('todo');

    const defaultMethodResponses: MethodResponse[] = [
      {
        statusCode: '200',
      },
      {
        statusCode: '400',
      }
    ];

    const getAllTodos = todo.addMethod(HttpMethod.GET, new AwsIntegration({
      service: 'dynamodb',
      action: 'Scan',
      integrationHttpMethod: HttpMethod.POST,
      options: {
        credentialsRole: integrationRole,
        requestTemplates: {
          'application/json': `{
            "TableName": "${ tableName }",
            "Limit": 10
          }`
        },
        passthroughBehavior: PassthroughBehavior.NEVER,
        integrationResponses: [
          {
            statusCode: '200',
            selectionPattern: '2\\d{2}',
            responseTemplates: {
              'application/json': `#set($inputRoot = $input.path('$'))
                [
                  #foreach($todo in $inputRoot.Items) {
                    "id": "$todo.id.S",
                    "title": "$todo.title.S",
                    "description": "$todo.description.S"
                  }#if($foreach.hasNext),#end
                #end
                ]`
            }
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseTemplates: {
              'application/json': `{ "error": "There was an error loading the To-Do objects." }`
            }
          }
        ]
      }
    }), {
      methodResponses: defaultMethodResponses
    });

    const createTodo = todo.addMethod(HttpMethod.PUT, new AwsIntegration({
      service: 'dynamodb',
      integrationHttpMethod: HttpMethod.POST,
      action: 'PutItem',
      options: {
        credentialsRole: integrationRole,
        requestTemplates: {
          'application/json': `{
            "TableName": "${ tableName }",
            "Item": {
              "id": {
                "S": "$input.path('$.id')"
              },
              "title": {
                "S": "$input.path('$.title')"
              },
              "description": {
                "S": "$input.path('$.description')"
              }
            },
            "ConditionExpression": "attribute_not_exists(id)"
          }`
        },
        passthroughBehavior: PassthroughBehavior.NEVER,
        integrationResponses: [
          {
            statusCode: '200',
            selectionPattern: '2\\d{2}',
            responseTemplates: {
              'application/json': `{ "message": "To-Do object created successfully." }`
            }
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseTemplates: {
              'application/json': `{ "message": "There was an error while creating a new To-Do object." }`
            }
          }
        ]
      }
    }), {
      methodResponses: defaultMethodResponses,
      requestValidator: requestBodyValidator,
      requestModels: {
        'application/json': todoModel
      }
    });

    const singleTodo = todo.addResource('{todoId}');

    const getSingleTodo = singleTodo.addMethod(HttpMethod.GET, new AwsIntegration({
      service: 'dynamodb',
      integrationHttpMethod: HttpMethod.POST,
      action: 'GetItem',
      options: {
        credentialsRole: integrationRole,
        requestTemplates: {
          'application/json': `{
            "TableName": "${ tableName }",
            "Key": {
              "id": {
                 "S": "$input.params('todoId')"
              }
            }
          }`
        },
        integrationResponses: [
          {
            statusCode: '200',
            selectionPattern: '2\\d{2}',
            responseTemplates: {
              'application/json': `#set($todo = $input.path('$.Item'))
                #if($todo == "")
                #set($context.responseOverride.status = 400)
                { "error": "There was an error loading the To-Do objects." }
                #else
                {
                    "id": "$todo.id.S",
                    "title": "$todo.title.S",
                    "description": "$todo.description.S"
                }
                #end`
            }
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseTemplates: {
              'application/json': `{ "error": "There was an error loading the To-Do objects." }`
            }
          }
        ],
        requestParameters: {
          'integration.request.path.todoId': 'method.request.path.todoId'
        }
      }
    }), {
      requestParameters: {
        'method.request.path.todoId': true
      },
      methodResponses: defaultMethodResponses
    });

    const updateSingleTodo = singleTodo.addMethod(HttpMethod.PUT, new AwsIntegration({
      service: 'dynamodb',
      integrationHttpMethod: HttpMethod.POST,
      action: 'PutItem',
      options: {
        credentialsRole: integrationRole,
        requestTemplates: {
          'application/json': `{
            "TableName": "${ tableName }",
            "Item": {
              "id": {
                "S": "$input.params('todoId')"
              },
              "title": {
                "S": "$input.path('$.title')"
              },
              "description": {
                "S": "$input.path('$.description')"
              }
            },
            "ConditionExpression": "attribute_exists(id)"
          }`
        },
        integrationResponses: [
          {
            statusCode: '200',
            selectionPattern: '2\\d{2}',
            responseTemplates: {
              'application/json': `{ "message": "To-Do object updated successfully." }`
            }
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseTemplates: {
              'application/json': `{ "error": "There was an error while updating the To-Do object." }`
            }
          }
        ],
        requestParameters: {
          'integration.request.path.todoId': 'method.request.path.todoId'
        }
      }
    }), {
      requestParameters: {
        'method.request.path.todoId': true
      },
      requestModels: {
        'application/json': todoModel
      },
      requestValidator: requestBodyValidator,
      methodResponses: defaultMethodResponses
    });

    const deleteSingleTodo = singleTodo.addMethod(HttpMethod.DELETE, new AwsIntegration({
      service: 'dynamodb',
      integrationHttpMethod: HttpMethod.POST,
      action: 'DeleteItem',
      options: {
        credentialsRole: integrationRole,
        requestTemplates: {
          'application/json': `{
            "TableName": "${ tableName }",
            "Key": {
              "id": {
                "S": "$input.params('todoId')"
              }
            },
            "ConditionExpression": "attribute_exists(id)"
          }`
        },
        integrationResponses: [
          {
            statusCode: '200',
            selectionPattern: '2\\d{2}',
            responseTemplates: {
              'application/json': '{ "message": "To-Do object deleted successfully." }'
            }
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseTemplates: {
              'application/json': '{ "error": "There has been an error while deleting the To-Do object." }'
            }
          }
        ],
        requestParameters: {
          'integration.request.path.todoId': 'method.request.path.todoId'
        }
      }
    }), {
      requestParameters: {
        'method.request.path.todoId': true
      },
      methodResponses: defaultMethodResponses
    });
  }
}
