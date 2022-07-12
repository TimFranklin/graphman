// deno-lint-ignore-file no-explicit-any
// Note: some any types are hard to remove here, because of the recusive types of the introspection
import * as graphql from "https://esm.sh/graphql@16.5.0";

interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: null[];
    body: {
      mode: string;
      graphql: {
        query: string;
        variables: string;
      };
    };
    url: {
      raw: string;
      protocol: string;
      host: string[];
      path: string[];
    };
  };
  response: null[];
}

interface PostmanCollection {
  info: {
    name: string;
    schema: string;
  };
  item: PostmanItem[];
}

function query(url: string, query: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
    }),
  }).then((res) => res.json());
}

function findType(
  typeName: string,
  introspectionQuery: graphql.IntrospectionQuery
): graphql.IntrospectionType | undefined {
  const types = introspectionQuery.__schema.types;
  return types.find((type) => type.name === typeName);
}

export function saveJsonFormatted(json: any, fileName: string) {
  Deno.writeTextFileSync(fileName, JSON.stringify(json, null, "\t"));
}
interface Argument {
  formatedType: string;
  formatedVariable: string;
  defaultValue: string | "null" | "#";
}
interface Field {
  formatedField: string;
}
class TypeFormater {
  args = new Map<string, Argument>();
  fileds = new Map<string, Field>();
  introspection: graphql.IntrospectionQuery;

  constructor(introspection: graphql.IntrospectionQuery) {
    this.introspection = introspection;
  }

  getBaseType(type: any): { name: string; kind: string } {
    if (type.kind === "LIST" || type.kind === "NON_NULL") {
      return this.getBaseType(type.ofType);
    } else {
      return { name: type.name, kind: type.kind };
    }
  }

  formatArgument(arg: graphql.IntrospectionInputValue): Argument {
    function formatArgType(type: any): string {
      if (type.kind === "SCALAR" || type.kind === "ENUM") {
        return type.name;
      } else if (type.kind === "OBJECT") {
        return type.name;
      } else if (type.kind === "LIST") {
        return `[${formatArgType(type.ofType)}]`;
      } else if (type.kind === "NON_NULL") {
        return `${formatArgType(type.ofType)}!`;
      } else {
        return type.name;
      }
    }

    const defaultValue = arg.type.kind === "NON_NULL" ? "#" : "null";
    const formatedArg = {
      defaultValue,
      formatedType: formatArgType(arg.type),
      formatedVariable: `"${arg.name}": ${defaultValue}`,
    };

    this.args.set(arg.name, formatedArg);
    return formatedArg;
  }

  formatField(field: graphql.IntrospectionField): Field {
    let description = "\n";
    if (
      field.description &&
      field.description !== "undefined" &&
      field.description !== ""
    ) {
      description = ` # ${field.description?.replace("\n", " ")}\n`;
    }

    function scalarFormat(field: graphql.IntrospectionField | any) {
      return `\t\t${field.name}${description}`;
    }

    function objectFormat(field: graphql.IntrospectionField | any) {
      return `\t\t# ${field.name}${description}`;
    }

    function othersFormat(field: graphql.IntrospectionField | any) {
      return `\t\t# ${field.name}${description} # Type: ${field.type?.kind}\n`;
    }

    const baseType = this.getBaseType(field.type);
    let formatedFieldTxt = "";
    if (baseType.kind === "SCALAR" || baseType.kind === "ENUM") {
      formatedFieldTxt = scalarFormat(field);
    } else if (baseType.kind === "OBJECT") {
      formatedFieldTxt = objectFormat(field);
    } else {
      formatedFieldTxt = othersFormat(field);
    }

    const formatedField = {
      formatedField: formatedFieldTxt,
    };

    this.fileds.set(field.name, formatedField);
    return formatedField;
  }
}

function fieldToItem(
  field: graphql.IntrospectionField,
  url: string,
  typeFormater: TypeFormater,
  type: "query" | "mutation"
): PostmanItem {
  let queryVarsDefinition = "";
  let fieldVars = "";
  let variables = "";

  // @TODO: remove any types
  field.args.forEach((arg: any, index) => {
    const formatedArg = typeFormater.formatArgument(arg);
    queryVarsDefinition += `${index === 0 ? "" : ","}${
      field.args.length > 3 ? "\n\t" : " "
    }$${arg.name}: ${formatedArg.formatedType}`;

    fieldVars += `${index === 0 ? "" : ", "}${
      field.args.length > 3 ? "\n\t\t" : " "
    }${arg.name}: $${arg.name}`;

    variables += `${index === 0 ? "" : ",\n"}\t${formatedArg.formatedVariable}`;
  });

  if (field.args.length > 3) {
    queryVarsDefinition += "\n";
    fieldVars += "\n\t";
  }

  let formatedFields = "";

  // @TODO: remove any types
  const _field = field as any;
  const fieldBaseType = typeFormater.getBaseType(_field.type);
  const queryReturnedType = findType(
    fieldBaseType.name,
    typeFormater.introspection
  ) as graphql.IntrospectionObjectType;

  if (queryReturnedType.kind === "OBJECT") {
    queryReturnedType.fields.forEach((field) => {
      const formatedField = typeFormater.formatField(field);
      formatedFields += formatedField.formatedField;
    });
  }

  const hasArgs = field.args.length > 0;
  const hasFields =
    queryReturnedType.kind === "OBJECT" && queryReturnedType.fields.length > 0;
  const itemQuery = graphql.print(
    graphql.parse(
      `${type} ${field.name}${hasArgs ? `(${queryVarsDefinition})` : ""}{\n\t${
        field.name
      }${hasArgs ? `(${fieldVars})` : ""}${
        hasFields ? `{\n${formatedFields}\t}` : ""
      }\n}`
    )
  );

  const formattedVariables = `{\n${variables}\n}`;

  const baseUrl = url.split("//")[1];
  const rootUrl = baseUrl.split("/")[0];
  const path = url.split("//")[1].split("/").slice(1);
  const host = [...rootUrl.split(".")];
  const protocol = url.split("://")[0];

  const postmanItem: PostmanItem = {
    name: field.name,
    request: {
      method: "POST",
      header: [],
      body: {
        mode: "graphql",
        graphql: {
          query: itemQuery,
          variables: formattedVariables,
        },
      },
      url: {
        raw: url,
        protocol,
        host,
        path,
      },
    },
    response: [],
  };

  return postmanItem;
}

export async function createPostmanCollection(url: string) {
  const introspectionQueryString = graphql.getIntrospectionQuery();
  const introspection = await query(url, introspectionQueryString);
  const introspectionQuery = introspection.data as graphql.IntrospectionQuery;

  const queryType = introspectionQuery.__schema.types.find(
    (type) => type.name === "Query"
  ) as graphql.IntrospectionObjectType;
  if (!queryType) throw new Error("Query type not found");

  const mutationType = introspectionQuery.__schema.types.find(
    (type) => type.name === "Mutation"
  ) as graphql.IntrospectionObjectType;
  if (!queryType) throw new Error("Mutation type not found");

  const item: PostmanItem[] = [];

  const queryTypeGetter = new TypeFormater(introspectionQuery);

  queryType.fields.forEach((field) => {
    const postmanItem = fieldToItem(field, url, queryTypeGetter, "query");
    item.push(postmanItem);
  });

  mutationType?.fields.forEach((field) => {
    const postmanItem = fieldToItem(field, url, queryTypeGetter, "mutation");
    item.push(postmanItem);
  });

  const name = url.split("//")[1].split("/")[0] + "-autoGQL";
  const collection: PostmanCollection = {
    info: {
      name,
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item,
  };

  return collection;
}
