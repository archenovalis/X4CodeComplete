import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { logger } from './logger';
import { types } from 'util';

export class XsdSchemaManager {
  private loadedSchemas: Map<string, any> = new Map();
  private parsedSchemas: Map<string, any> = new Map();
  private elementsWithTypedAttributes: Map<string, Map<string, Map<string, string[]>>> = new Map();
  private typesWithRestriction: Map<string, Map<string, string[]>> = new Map();

  /**
   * Load and parse an XSD schema file, including any referenced schemas
   */
  public async loadSchema(schemaPath: string): Promise<boolean> {
    try {
      if (this.loadedSchemas.has(schemaPath)) {
        logger.debug(`Schema ${schemaPath} already loaded`);
        return true;
      }

      logger.info(`Loading XSD schema: ${schemaPath}`);
      const xsdContent = await fs.promises.readFile(schemaPath, 'utf8');

      // Parse the XSD content
      const parser = new xml2js.Parser({
        explicitCharkey: true,
        explicitArray: false,
        mergeAttrs: true,
        normalizeTags: false,
        attrNameProcessors: [
          (name) => {
            // Remove namespace prefixes from attributes
            const parts = name.split(':');
            return parts[parts.length - 1];
          },
        ],
      });

      const result = await parser.parseStringPromise(xsdContent);
      this.loadedSchemas.set(schemaPath, result);
      // Process includes (if any)
      await this.processIncludes(result, schemaPath);

      // Store the parsed schema
      this.parsedSchemas.set(schemaPath, result);

      logger.info(`Successfully loaded schema: ${schemaPath}`);

      return true;
    } catch (error) {
      logger.error(`Error loading schema ${schemaPath}: ${error}`);
      return false;
    }
  }

  /**
   * Process any xs:include elements in the schema
   */
  private async processIncludes(schema: any, basePath: string): Promise<void> {
    if (!schema || !schema['xs:schema']) {
      return;
    }

    const schemaRoot = schema['xs:schema'];

    // Handle xs:include elements
    const includes = schemaRoot['xs:include'];
    if (includes) {
      const includeArray = Array.isArray(includes) ? includes : [includes];

      for (const include of includeArray) {
        if (include && include.schemaLocation) {
          const schemaLocation = include.schemaLocation;
          const includePath = path.resolve(path.dirname(basePath), schemaLocation);

          logger.info(`Processing included schema: ${schemaLocation} (resolved to ${includePath})`);

          // Load and parse the included schema
          await this.loadIncludedSchema(includePath, schema);
        }
      }
    }
  }

  /**
   * Load an included schema and merge its contents with the parent schema
   */
  private async loadIncludedSchema(includePath: string, parentSchema: any): Promise<void> {
    try {
      let includedSchema: any;
      if (!this.loadedSchemas.has(includePath)) {
        const xsdContent = await fs.promises.readFile(includePath, 'utf8');

        const parser = new xml2js.Parser({
          explicitCharkey: true,
          explicitArray: false,
          mergeAttrs: true,
          normalizeTags: false,
          attrNameProcessors: [
            (name) => {
              // Remove namespace prefixes from attributes
              const parts = name.split(':');
              return parts[parts.length - 1];
            },
          ],
        });

        includedSchema = await parser.parseStringPromise(xsdContent);

        // Mark this schema as loaded
        this.loadedSchemas.set(includePath, includedSchema);
      } else {
        includedSchema = this.loadedSchemas.get(includePath);
        if (!includedSchema) {
          logger.error(`Included schema ${includePath} not found in loaded schemas`);
          return;
        }
        logger.debug(`Using cached schema for ${includePath}`);
      }
      // Merge the included schema into the parent schema
      this.mergeSchemas(parentSchema, includedSchema);

      // Process any nested includes
      await this.processIncludes(includedSchema, includePath);
    } catch (error) {
      logger.error(`Error loading included schema ${includePath}: ${error}`);
    }
  }

  /**
   * Merge the included schema elements into the parent schema
   */
  private mergeSchemas(parentSchema: any, includedSchema: any): void {
    if (!includedSchema || !includedSchema['xs:schema'] || !parentSchema || !parentSchema['xs:schema']) {
      return;
    }

    const parentRoot = parentSchema['xs:schema'];
    const includedRoot = includedSchema['xs:schema'];

    // List of XSD element types to merge (simpleTypes, complexTypes, elements, etc.)
    const elementsToMerge = [
      'xs:simpleType',
      'xs:complexType',
      'xs:element',
      'xs:attribute',
      'xs:attributeGroup',
      'xs:group',
    ];

    for (const elementType of elementsToMerge) {
      if (includedRoot[elementType]) {
        // If the parent doesn't have this element type yet, create it
        if (!parentRoot[elementType]) {
          parentRoot[elementType] = [];
        } else if (!Array.isArray(parentRoot[elementType])) {
          parentRoot[elementType] = [parentRoot[elementType]];
        }

        // Add the included elements to the parent
        const includedElements = Array.isArray(includedRoot[elementType])
          ? includedRoot[elementType]
          : [includedRoot[elementType]];

        parentRoot[elementType].push(...includedElements);
      }
    }
  }

  /**
   * Find an element definition by name in the appropriate schema based on script type
   * @param scriptType The script type (e.g. "aiscript", "mdscript")
   * @param elementName The name of the element to find
   * @returns The element definition if found, otherwise undefined
   */
  public findElementDefinition(scriptType: string, elementName: string): any {
    // First, try to find a schema that directly matches the script type
    if (!scriptType || !elementName) {
      logger.warn('Script type or element name is not provided');
      return undefined;
    }

    const schema = this.getSchema(scriptType);
    if (schema) {
      const elementDef = this.findElementInSchema(schema, elementName);
      if (elementDef) {
        return elementDef;
      }
    }

    // Element not found in any schema
    return undefined;
  }

  /**
   * Search for an element by name within a schema
   * @param schema The schema to search in
   * @param elementName The name of the element to find
   * @returns The element definition if found, otherwise undefined
   */
  private findElementInSchema(schema: any, elementName: string): any {
    if (!schema) {
      return undefined;
    }
    let result = undefined;
    // Check for direct element definitions
    if (schema['xs:element']) {
      const elements = Array.isArray(schema['xs:element']) ? schema['xs:element'] : [schema['xs:element']];

      result = elements.find((element: any) => element.name === elementName);
    }

    // Check for elements in complex types
    if (result === undefined && schema['xs:complexType']) {
      const complexTypes = Array.isArray(schema['xs:complexType'])
        ? schema['xs:complexType']
        : [schema['xs:complexType']];

      for (const complexType of complexTypes) {
        // Deep search in complex types for element references
        const nestedElement = this.findNestedElement(complexType, elementName);
        if (nestedElement) {
          result = nestedElement;
          break;
        }
      }
    }

    // Check for elements in groups
    if (result === undefined && schema['xs:group']) {
      const groups = Array.isArray(schema['xs:group']) ? schema['xs:group'] : [schema['xs:group']];

      for (const group of groups) {
        if (group && group.name) {
          // Deep search in groups for element references
          const nestedElement = this.findNestedElement(group, elementName);
          if (nestedElement) {
            result = nestedElement;
            break;
          }
        }
      }
    }

    if (result && result['type'] !== undefined) {
      // If the element has a type, we need to find the definition of that type
      const typeName = result['type'];
      let typeDefinition = undefined;
      if (schema['xs:simpleType']) {
        const simpleTypes = Array.isArray(schema['xs:simpleType'])
          ? schema['xs:simpleType']
          : [schema['xs:simpleType']];
        typeDefinition = simpleTypes.find((type: any) => type.name === typeName);
      }
      if (typeDefinition === undefined && schema['xs:complexType']) {
        const complexTypes = Array.isArray(schema['xs:complexType'])
          ? schema['xs:complexType']
          : [schema['xs:complexType']];

        typeDefinition = complexTypes.find((type: any) => type.name === typeName);
      }
      if (typeDefinition) {
        result = typeDefinition;
      }
    }

    return result;
  }

  /**
   * Recursively search for an element within a complex type or group
   */
  private findNestedElement(node: any, elementName: string): any {
    if (!node) return undefined;

    // Check direct children for elements
    const checkNodes = (nodeList: any[]): any => {
      if (!nodeList) return undefined;

      for (const childNode of nodeList) {
        if (childNode && childNode.name === elementName) {
          return childNode;
        }

        // Recursively check nested elements
        const nestedResult = this.findNestedElement(childNode, elementName);
        if (nestedResult) {
          return nestedResult;
        }
      }
      return undefined;
    };

    // Check all potential element containers
    const containers = ['xs:element', 'xs:sequence', 'xs:choice', 'xs:all', 'xs:complexContent', 'xs:extension'];

    for (const container of containers) {
      if (node[container]) {
        const nodeList = Array.isArray(node[container]) ? node[container] : [node[container]];
        const result = checkNodes(nodeList);
        if (result) return result;
      }
    }

    return undefined;
  }

  /**
   * Get the parsed schema
   */
  public getSchema(scriptType: string): any {
    const schemaKey = Array.from(this.parsedSchemas.keys()).find((key) =>
      key.toLowerCase().includes(scriptType.toLowerCase())
    );
    if (schemaKey) {
      const schema = this.parsedSchemas.get(schemaKey);
      if (schema && schema['xs:schema']) {
        return schema['xs:schema'];
      }
    }
    return undefined;
  }

  /**
   * Get all attribute names of an element that have appropriate types
   * @param scriptType The script type (e.g. "aiscript", "mdscript")
   * @param elementName The name of the element to check
   * @param attributeTypes Array of types to filter attributes by (e.g., ["lvaluename", "expression"])
   * @returns Array of attribute names with appropriate types
   */
  elementAttributesByTypes(scriptType: string, elementName: string, attributeTypes: string[]): string[] {
    const result: Map<string, string[]> = new Map();
    const typeToProcess: string[] = [];
    if (
      this.elementsWithTypedAttributes.has(scriptType) &&
      this.elementsWithTypedAttributes.get(scriptType).has(elementName)
    ) {
      const attributesByType = this.elementsWithTypedAttributes.get(scriptType).get(elementName);
      for (const type of attributeTypes) {
        if (attributesByType && attributesByType.has(type)) {
          result.set(type, attributesByType.get(type));
        } else {
          typeToProcess.push(type);
        }
      }
      if (typeToProcess.length === 0) {
        return Array.from(result.values()).flat();
      }
    } else {
      typeToProcess.push(...attributeTypes);
    }
    const schema = this.getSchema(scriptType);
    if (schema) {
      const elementDef = this.findElementInSchema(schema, elementName);
      if (elementDef && typeof elementDef === 'object' && elementDef !== null) {
        const elementContent = Array.isArray(elementDef) ? elementDef : [elementDef];
        for (const item of elementContent) {
          const attributes = this.collectAttributesByType(schema, item, typeToProcess);
          for (const [type, names] of attributes) {
            result.set(type, (result.get(type) || []).concat(names));
          }
        }
      }
    }
    if (!this.elementsWithTypedAttributes.has(scriptType)) {
      this.elementsWithTypedAttributes.set(scriptType, new Map<string, Map<string, string[]>>());
    }
    if (!this.elementsWithTypedAttributes.get(scriptType).has(elementName)) {
      this.elementsWithTypedAttributes.get(scriptType).set(elementName, new Map<string, string[]>());
    }
    const attributesByType = this.elementsWithTypedAttributes.get(scriptType).get(elementName);
    const resultArray: string[] = [];
    for (const type of attributeTypes) {
      if (!attributesByType.has(type)) {
        attributesByType.set(type, result.get(type) || []);
      }
      resultArray.push(...(result.get(type) || []));
    }
    return resultArray;
  }

  private collectAttributesByType(schema: any, object: any, typeToProcess: string[]): Map<string, string[]> {
    const result: Map<string, string[]> = new Map();

    const keys = Object.keys(object);

    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'object' && value !== null) {
        if (key === 'xs:attribute') {
          const attributes = Array.isArray(value) ? value : [value];
          for (const attr of attributes) {
            if (attr.type && typeToProcess.includes(attr.type)) {
              result.set(attr.type, (result.get(attr.type) || []).concat(attr.name));
            }
          }
        } else if (key === 'xs:attributeGroup') {
          const attrGroups = Array.isArray(value) ? value : [value];
          for (const group of attrGroups) {
            if (group.ref) {
              const groupAttrs = this.findAttributeGroupAttributesByType(schema, group.ref, typeToProcess);
              for (const [type, names] of groupAttrs) {
                result.set(type, (result.get(type) || []).concat(names));
              }
            }
          }
        } else {
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) {
            const attributes = this.collectAttributesByType(schema, item, typeToProcess);
            for (const [type, names] of attributes) {
              result.set(type, (result.get(type) || []).concat(names));
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Find all attributes with appropriate types in an attribute group
   * @param schema The parsed XSD schema
   * @param groupName Name of the attribute group
   * @param typeToProcess Array of types to filter attributes by (e.g., ["lvaluename", "expression"])
   * @returns Array of attribute names with appropriate types
   */
  private findAttributeGroupAttributesByType(
    schema: any,
    groupName: string,
    typeToProcess: string[]
  ): Map<string, string[]> {
    const result: Map<string, string[]> = new Map();

    if (schema) {
      // Find attribute group definition
      if (schema['xs:attributeGroup']) {
        const groups = Array.isArray(schema['xs:attributeGroup'])
          ? schema['xs:attributeGroup']
          : [schema['xs:attributeGroup']];

        for (const group of groups) {
          if (group.name === groupName) {
            // Process attributes in this group
            if (group['xs:attribute']) {
              const attributes = Array.isArray(group['xs:attribute']) ? group['xs:attribute'] : [group['xs:attribute']];

              for (const attr of attributes) {
                if (attr.type && typeToProcess.includes(attr.type)) {
                  result.set(attr.type, (result.get(attr.type) || []).concat(attr.name));
                }
              }
            }

            // Process nested attribute groups
            if (group['xs:attributeGroup']) {
              const nestedGroups = Array.isArray(group['xs:attributeGroup'])
                ? group['xs:attributeGroup']
                : [group['xs:attributeGroup']];

              for (const nestedGroup of nestedGroups) {
                if (nestedGroup.ref) {
                  // Recursively get attributes from nested groups
                  const nestedAttrs = this.findAttributeGroupAttributesByType(schema, nestedGroup.ref, typeToProcess);
                  for (const [type, names] of nestedAttrs) {
                    result.set(type, (result.get(type) || []).concat(names));
                  }
                }
              }
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Find all simple type names that have a specified restriction base
   * @param scriptType The script type (e.g. "aiscript", "mdscript")
   * @param restrictionBase The base name to search for (e.g. "expression", "lvalueexpression")
   * @returns Array of simple type names that restrict the specified base
   */
  getTypesWithRestriction(scriptType: string, restrictionBase: string): string[] {
    const result: string[] = [];
    if (this.typesWithRestriction.has(scriptType) && this.typesWithRestriction.get(scriptType).has(restrictionBase)) {
      return this.typesWithRestriction.get(scriptType).get(restrictionBase);
    }
    const schemaRoot = this.getSchema(scriptType);

    // Look for simple types with the given restriction base
    if (schemaRoot['xs:simpleType']) {
      const simpleTypes = Array.isArray(schemaRoot['xs:simpleType'])
        ? schemaRoot['xs:simpleType']
        : [schemaRoot['xs:simpleType']];

      for (const simpleType of simpleTypes) {
        try {
          if (!simpleType || !simpleType.name) {
            continue; // Skip unnamed types
          }

          if (simpleType['xs:restriction'] && simpleType['xs:restriction'].base === restrictionBase) {
            result.push(simpleType.name);
          }

          // Also check for nested restrictions
          // if (simpleType['xs:union'] && simpleType['xs:union'].memberTypes) {
          //   const memberTypes = simpleType['xs:union'].memberTypes.split(' ');
          //   if (memberTypes.includes(restrictionBase)) {
          //     result.push(simpleType.name);
          //   }
          // }
        } catch (error) {
          // Skip any types that cause errors
          continue;
        }
      }
    }
    if (!this.typesWithRestriction.has(scriptType)) {
      this.typesWithRestriction.set(scriptType, new Map<string, string[]>());
    }
    if (!this.typesWithRestriction.get(scriptType).has(restrictionBase)) {
      this.typesWithRestriction.get(scriptType).set(restrictionBase, result);
    }
    return result;
  }
}

// Singleton instance
export const xsdManager = new XsdSchemaManager();
