import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { logger } from './logger';

/**
 * Represents attributes of an element, including its parent name and a map of attributes.
 * This is used to store attributes for elements in a structured way.
 */
export class AttributeOfElement {
  parentName: string;
  attributes: Map<string, object>;
  constructor(parentName: string = '', attributes: Map<string, object> = new Map()) {
    this.parentName = parentName;
    this.attributes = attributes;
  }
}

/**
 * Represents a single value for an attribute, including optional documentation.
 * This is used to store enumerated values for attributes in a structured way.
 */
export class AttributeValue {
  value: string;
  documentation?: string;

  constructor(value: string, documentation?: string) {
    this.value = value;
    this.documentation = documentation;
  }
}

/**
 * Represents a collection of possible values for an attribute, including documentation.
 * This is used to store enumerated values for attributes in a structured way.
 */
export class AttributeValuesItem {
  parentName: string;
  values: AttributeValue[];

  constructor(parentName: string = '', values: AttributeValue[] = []) {
    this.parentName = parentName;
    this.values = values;
  }
}

/**
 * Represents a single, fully-resolved XSD schema with all includes merged.
 */
class Schema {
  private rootSchema: any;
  private elementCache = new Map<string, any[] | null>();
  private typeCache = new Map<string, any | null>();
  private attributeGroupCache = new Map<string, any | null>();
  private allAttributesCache = new Map<string, any[][]>();
  private allAttributesMapCache = new Map<string, AttributeOfElement[]>();
  private attributeValuesCache = new Map<string, AttributeValuesItem[]>();
  private missingAttributesCache = new Map<string, any[]>();
  private childElementsCache = new Map<string, any[]>();
  private attributesByTypesCache = new Map<string, string[]>();

  constructor(schema: any) {
    this.rootSchema = schema;
  }

  /**
   * Finds all definitions for an element by name within this schema.
   * @param elementName The name of the element to find.
   * @returns An array of element definitions.
   */
  public findElementDefinition(elementName: string): any[] {
    if (this.elementCache.has(elementName)) {
      const cached = this.elementCache.get(elementName);
      return cached === null ? [] : cached;
    }
    if (!this.rootSchema) {
      this.elementCache.set(elementName, null);
      return [];
    }
    const definitions: any[] = [];
    const visited = new Set();
    this.findNestedElementDefinitions(this.rootSchema, elementName, visited, definitions, undefined);
    this.elementCache.set(elementName, definitions.length > 0 ? definitions : null);
    return definitions;
  }

  /**
   * Recursively searches for all element definitions within a schema node.
   */
  private findNestedElementDefinitions(
    node: any,
    elementName: string,
    visited: Set<any>,
    definitions: any[],
    parentNode?: any
  ): void {
    if (!node || typeof node !== 'object' || visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        this.findNestedElementDefinitions(item, elementName, visited, definitions, parentNode);
      }
    } else {
      for (const key in node) {
        if (key === 'xs:element') {
          const elements = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const el of elements) {
            if (el?.$?.name === elementName) {
              const newDef = { ...el };
              if (parentNode?.$?.name) {
                newDef.parentName = parentNode.$.name;
              }
              definitions.push(newDef);
            }
            // Recurse into the element definition, passing it as the new parent.
            this.findNestedElementDefinitions(el, elementName, visited, definitions, el);

            // Handle type attribute to find nested elements within types
            if (el?.$?.type) {
              const typeDef = this.findTypeDefinition(el.$.type);
              if (typeDef) {
                this.findNestedElementDefinitions(typeDef, elementName, visited, definitions, el);
              }
            }
          }
        } else if (key !== '$' && typeof node[key] === 'object') {
          this.findNestedElementDefinitions(node[key], elementName, visited, definitions, parentNode);
        }
      }
    }
  }

  /**
   * Finds a type definition (simpleType or complexType) by name.
   */
  public findTypeDefinition(typeName: string): any {
    if (this.typeCache.has(typeName)) {
      const cached = this.typeCache.get(typeName);
      return cached === null ? undefined : cached;
    }
    if (!this.rootSchema || !this.rootSchema['xs:schema']) {
      this.typeCache.set(typeName, null);
      return undefined;
    }
    const schemaRoot = this.rootSchema['xs:schema'];

    const simpleTypes = schemaRoot['xs:simpleType']
      ? Array.isArray(schemaRoot['xs:simpleType'])
        ? schemaRoot['xs:simpleType']
        : [schemaRoot['xs:simpleType']]
      : [];
    for (const type of simpleTypes) {
      if (type?.$?.name === typeName) {
        this.typeCache.set(typeName, type);
        return type;
      }
    }

    const complexTypes = schemaRoot['xs:complexType']
      ? Array.isArray(schemaRoot['xs:complexType'])
        ? schemaRoot['xs:complexType']
        : [schemaRoot['xs:complexType']]
      : [];
    for (const type of complexTypes) {
      if (type?.$?.name === typeName) {
        this.typeCache.set(typeName, type);
        return type;
      }
    }
    this.typeCache.set(typeName, null);
    return undefined;
  }

  /**
   * Finds an attribute group definition by name.
   */
  public findAttributeGroupDefinition(groupName: string): any {
    if (this.attributeGroupCache.has(groupName)) {
      const cached = this.attributeGroupCache.get(groupName);
      return cached === null ? undefined : cached;
    }
    if (!this.rootSchema || !this.rootSchema['xs:schema']) {
      this.attributeGroupCache.set(groupName, null);
      return undefined;
    }
    const schemaRoot = this.rootSchema['xs:schema'];

    const attributeGroups = schemaRoot['xs:attributeGroup']
      ? Array.isArray(schemaRoot['xs:attributeGroup'])
        ? schemaRoot['xs:attributeGroup']
        : [schemaRoot['xs:attributeGroup']]
      : [];
    for (const group of attributeGroups) {
      if (group?.$?.name === groupName) {
        this.attributeGroupCache.set(groupName, group);
        return group;
      }
    }
    this.attributeGroupCache.set(groupName, null);
    return undefined;
  }

  /**
   * Recursively collects all attributes for a given element definition or complex type.
   */
  private collectAttributes(definition: any, collectedAttributes: Map<string, any>): void {
    if (!definition) return;

    const attributes = definition['xs:attribute']
      ? Array.isArray(definition['xs:attribute'])
        ? definition['xs:attribute']
        : [definition['xs:attribute']]
      : [];
    for (const attr of attributes) {
      if (attr?.$?.name && !collectedAttributes.has(attr.$.name)) {
        collectedAttributes.set(attr.$.name, attr);
      }
    }

    const attributeGroups = definition['xs:attributeGroup']
      ? Array.isArray(definition['xs:attributeGroup'])
        ? definition['xs:attributeGroup']
        : [definition['xs:attributeGroup']]
      : [];
    for (const groupRef of attributeGroups) {
      if (groupRef?.$?.ref) {
        const groupDef = this.findAttributeGroupDefinition(groupRef.$.ref);
        if (groupDef) {
          this.collectAttributes(groupDef, collectedAttributes);
        }
      }
    }

    const complexContent = definition['xs:complexContent'];
    if (complexContent?.['xs:extension']) {
      const extension = complexContent['xs:extension'];
      this.collectAttributes(extension, collectedAttributes);
      if (extension?.$?.base) {
        const baseTypeDef = this.findTypeDefinition(extension.$.base);
        if (baseTypeDef) {
          this.collectAttributes(baseTypeDef, collectedAttributes);
        }
      }
    }
  }

  /**
   * Gets all possible attributes for a given element.
   */
  public getAllPossibleAttributes(elementName: string): any[] {
    if (this.allAttributesCache.has(elementName)) {
      return this.allAttributesCache.get(elementName)!;
    }
    const elementDefs = this.findElementDefinition(elementName);
    if (elementDefs.length === 0) {
      this.allAttributesCache.set(elementName, []);
      return [];
    }

    const allPossibleAttributes: any[] = [];

    for (const elementDef of elementDefs) {
      const collectedAttributes = new Map<string, any>();
      this.collectAttributes(elementDef, collectedAttributes);

      if (elementDef?.$?.type) {
        const typeDef = this.findTypeDefinition(elementDef.$.type);
        if (typeDef) {
          this.collectAttributes(typeDef, collectedAttributes);
        }
      }

      if (elementDef['xs:complexType']) {
        this.collectAttributes(elementDef['xs:complexType'], collectedAttributes);
      }

      const result = { parentName: elementDef.parentName, attributes: Array.from(collectedAttributes.values()) };
      for (const attr of result.attributes) {
        if (attr?.$?.type) {
          const typeDef = this.findTypeDefinition(attr.$.type);
          if (typeDef?.['xs:restriction']?.$?.base) {
            attr.$.restriction = typeDef['xs:restriction'].$.base;
          }
        }
      }
      allPossibleAttributes.push(result);
    }
    this.allAttributesCache.set(elementName, allPossibleAttributes);
    return allPossibleAttributes;
  }

  /**
   * Gets all possible attributes for a given element, returning an array of maps for each definition variant.
   */
  public getAllPossibleAttributesMap(elementName: string): AttributeOfElement[] {
    if (this.allAttributesMapCache.has(elementName)) {
      return this.allAttributesMapCache.get(elementName)!;
    }
    const attributeVariations = this.getAllPossibleAttributes(elementName);
    const resultVariations: AttributeOfElement[] = [];

    for (const attributesRecord of attributeVariations) {
      const newRecord = new AttributeOfElement(attributesRecord.parentName);
      for (const attr of attributesRecord.attributes) {
        if (!attr || !attr.$ || !attr.$.name) continue;
        const newAttr = {};
        for (const key of Object.keys(attr)) {
          if (key !== '$' && key !== 'xs:annotation') {
            newAttr[key] = attr[key];
          } else if (key === '$') {
            for (const subKey of Object.keys(attr.$)) {
              if (subKey !== 'name') {
                newAttr[subKey] = attr.$[subKey];
              }
            }
          } else if (key === 'xs:annotation') {
            if (attr['xs:annotation']?.['xs:documentation']) {
              const docNode = attr['xs:annotation']['xs:documentation'];
              newAttr['documentation'] = typeof docNode === 'string' ? docNode : docNode?._ || '';
            }
          }
        }
        newRecord.attributes.set(attr.$.name, newAttr);
      }
      resultVariations.push(newRecord);
    }
    this.allAttributesMapCache.set(elementName, resultVariations);
    return resultVariations;
  }

  /**
   * Gets possible enumeration values for a specific attribute of an element.
   */
  public getAttributePossibleValues(elementName: string, attributeName: string): AttributeValuesItem[] {
    const cacheKey = `${elementName}|${attributeName}`;
    if (this.attributeValuesCache.has(cacheKey)) {
      return this.attributeValuesCache.get(cacheKey)!;
    }
    const attributeVariations = this.getAllPossibleAttributes(elementName);
    if (attributeVariations.length === 0) {
      this.attributeValuesCache.set(cacheKey, []);
      return [];
    }

    const result: AttributeValuesItem[] = [];

    for (const attributesRecord of attributeVariations) {
      const resultItem = new AttributeValuesItem(attributesRecord.parentName);
      const attribute = attributesRecord.attributes.find((a: any) => a?.$?.name === attributeName);
      if (attribute) {
        const typeDef = this.findTypeDefinition(attribute.$.type);
        if (!typeDef) {
          this.attributeValuesCache.set(cacheKey, []);
          return [];
        }

        const processRestriction = (restriction: any) => {
          if (!restriction) return;
          const enumerations = restriction['xs:enumeration']
            ? Array.isArray(restriction['xs:enumeration'])
              ? restriction['xs:enumeration']
              : [restriction['xs:enumeration']]
            : [];
          for (const enumValue of enumerations) {
            let doc = '';
            if (enumValue['xs:annotation']?.['xs:documentation']) {
              const docNode = enumValue['xs:annotation']['xs:documentation'];
              doc = typeof docNode === 'string' ? docNode : docNode?._ || '';
            }
            if (enumValue?.$?.value) {
              resultItem.values.push(new AttributeValue(enumValue.$.value, doc.trim()));
            }
          }
        };

        if (typeDef['xs:restriction']) {
          processRestriction(typeDef['xs:restriction']);
        } else if (typeDef['xs:union']) {
          const memberTypes = typeDef['xs:union']?.$?.memberTypes?.split(' ') || [];
          for (const memberTypeName of memberTypes) {
            const memberTypeDef = this.findTypeDefinition(memberTypeName);
            if (memberTypeDef?.['xs:restriction']) {
              processRestriction(memberTypeDef['xs:restriction']);
            }
          }
        }
      }
      result.push(resultItem);
    }
    this.attributeValuesCache.set(cacheKey, result);
    return result;
  }

  /**
   * Gets a list of mandatory attributes that are missing from an element.
   */
  public getMissingMandatoryAttributes(elementName: string, existingAttributeNames: string[]): any[] {
    const cacheKey = `${elementName}|${[...existingAttributeNames].sort().join(',')}`;
    if (this.missingAttributesCache.has(cacheKey)) {
      return this.missingAttributesCache.get(cacheKey)!;
    }
    const allAttributeVariations = this.getAllPossibleAttributes(elementName);
    const existingSet = new Set(existingAttributeNames);
    // For simplicity, we check against the first variation.
    // A more sophisticated approach might be needed depending on desired behavior.
    const allAttributes = allAttributeVariations.length > 0 ? allAttributeVariations[0] : [];
    const result = allAttributes.filter((attr) => attr?.$?.use === 'required' && !existingSet.has(attr?.$?.name));
    this.missingAttributesCache.set(cacheKey, result);
    return result;
  }

  /**
   * Recursively collects all possible child elements from a definition.
   */
  private collectChildElements(definition: any, collectedElements: Map<string, any>): void {
    if (!definition) return;

    const processGroup = (group: any) => {
      if (!group) return;
      const elements = group['xs:element']
        ? Array.isArray(group['xs:element'])
          ? group['xs:element']
          : [group['xs:element']]
        : [];
      for (const el of elements) {
        const name = el?.$?.name || el?.$?.ref;
        if (name && !collectedElements.has(name)) {
          collectedElements.set(name, el);
        }
      }

      ['xs:sequence', 'xs:choice', 'xs:all'].forEach((container) => {
        if (group[container]) {
          const items = Array.isArray(group[container]) ? group[container] : [group[container]];
          items.forEach((item) => processGroup(item));
        }
      });
    };

    ['xs:sequence', 'xs:choice', 'xs:all'].forEach((container) => {
      if (definition[container]) {
        processGroup(definition[container]);
      }
    });

    const complexContent = definition['xs:complexContent'];
    if (complexContent?.['xs:extension']) {
      const extension = complexContent['xs:extension'];
      this.collectChildElements(extension, collectedElements);
      if (extension?.$?.base) {
        const baseTypeDef = this.findTypeDefinition(extension.$.base);
        if (baseTypeDef) {
          this.collectChildElements(baseTypeDef, collectedElements);
        }
      }
    }
  }

  /**
   * Gets a list of possible child elements for a given element.
   */
  public getPossibleChildElements(elementName: string): any[] {
    if (this.childElementsCache.has(elementName)) {
      return this.childElementsCache.get(elementName)!;
    }
    const elementDefs = this.findElementDefinition(elementName);
    if (elementDefs.length === 0) {
      this.childElementsCache.set(elementName, []);
      return [];
    }

    const collectedElements = new Map<string, any>();
    for (const elementDef of elementDefs) {
      if (elementDef['xs:complexType']) {
        this.collectChildElements(elementDef['xs:complexType'], collectedElements);
      }
      if (elementDef?.$?.type) {
        const typeDef = this.findTypeDefinition(elementDef.$.type);
        if (typeDef) {
          this.collectChildElements(typeDef, collectedElements);
        }
      }
    }
    const result = Array.from(collectedElements.values());
    this.childElementsCache.set(elementName, result);
    return result;
  }

  /**
   * Gets attribute names for an element that match a list of types.
   */
  public elementAttributesByTypes(elementName: string, types: string[]): string[] {
    const cacheKey = `${elementName}|${[...types].sort().join(',')}`;
    if (this.attributesByTypesCache.has(cacheKey)) {
      return this.attributesByTypesCache.get(cacheKey)!;
    }
    const allAttributesVariations = this.getAllPossibleAttributes(elementName);
    if (allAttributesVariations.length === 0) {
      this.attributesByTypesCache.set(cacheKey, []);
      return [];
    }
    const allAttributes = allAttributesVariations[0];
    const typeSet = new Set(types);
    const result: string[] = [];
    for (const attr of allAttributes) {
      if (attr?.$?.type && typeSet.has(attr.$.type)) {
        result.push(attr.$.name);
      }
    }
    this.attributesByTypesCache.set(cacheKey, result);
    return result;
  }
}

/**
 * Manages loading and accessing different XSD schema contexts.
 */
export class XsdReference {
  private schemas: Map<string, Schema> = new Map();
  private schemaPaths: Map<string, string>;

  constructor(schemaPaths: Map<string, string>) {
    this.schemaPaths = schemaPaths;
  }

  public async initialize(): Promise<void> {
    for (const [scriptType, schemaPath] of this.schemaPaths.entries()) {
      try {
        const schemaRoot = await this.loadAndParseSchema(schemaPath);
        if (schemaRoot) {
          this.schemas.set(scriptType, new Schema(schemaRoot));
          logger.info(`Successfully initialized schema for ${scriptType}`);
        }
      } catch (error) {
        logger.error(`Failed to initialize schema for ${scriptType} from ${schemaPath}: ${error}`);
      }
    }
  }

  private async loadAndParseSchema(schemaPath: string): Promise<any> {
    logger.info(`Loading XSD schema: ${schemaPath}`);
    const xsdContent = await fs.promises.readFile(schemaPath, 'utf8');

    const parser = new xml2js.Parser({
      explicitCharkey: true,
      explicitArray: false,
      mergeAttrs: false,
      normalizeTags: false,
      attrNameProcessors: [(name) => name.split(':').pop() || name],
    });

    const result = await parser.parseStringPromise(xsdContent);
    await this.processIncludes(result, schemaPath, new Set([path.resolve(schemaPath)]));
    return result;
  }

  private async processIncludes(schema: any, basePath: string, loadedPaths: Set<string>): Promise<void> {
    if (!schema?.['xs:schema']?.['xs:include']) {
      return;
    }
    const includes = schema['xs:schema']['xs:include'];
    const includeArray = Array.isArray(includes) ? includes : [includes];

    for (const include of includeArray) {
      if (include?.$?.schemaLocation) {
        const includePath = path.resolve(path.dirname(basePath), include.$.schemaLocation);
        if (loadedPaths.has(includePath)) {
          continue;
        }
        loadedPaths.add(includePath);
        logger.info(`Processing included schema: ${include.$.schemaLocation}`);
        await this.loadIncludedSchema(includePath, schema, loadedPaths);
      }
    }
  }

  private async loadIncludedSchema(includePath: string, parentSchema: any, loadedPaths: Set<string>): Promise<void> {
    try {
      const xsdBaseName = path.basename(includePath);
      let includedSchema;
      if (this.schemas.has(xsdBaseName)) {
        includedSchema = this.schemas.get(xsdBaseName);
      } else {
        const xsdContent = await fs.promises.readFile(includePath, 'utf8');
        const parser = new xml2js.Parser({
          explicitCharkey: true,
          explicitArray: false,
          mergeAttrs: false,
          normalizeTags: false,
          attrNameProcessors: [(name) => name.split(':').pop() || name],
        });
        includedSchema = await parser.parseStringPromise(xsdContent);
        this.schemas.set(xsdBaseName, includedSchema);
      }
      if (!includedSchema || !includedSchema['xs:schema']) {
        logger.warn(`Included schema at ${includePath} is empty or invalid.`);
        return;
      }
      this.mergeSchemas(parentSchema, includedSchema);
      await this.processIncludes(includedSchema, includePath, loadedPaths);
    } catch (error) {
      logger.error(`Error loading included schema ${includePath}: ${error}`);
    }
  }

  private mergeSchemas(parentSchema: any, includedSchema: any): void {
    const parentRoot = parentSchema?.['xs:schema'];
    const includedRoot = includedSchema?.['xs:schema'];
    if (!parentRoot || !includedRoot) return;

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
        if (!parentRoot[elementType]) {
          parentRoot[elementType] = [];
        } else if (!Array.isArray(parentRoot[elementType])) {
          parentRoot[elementType] = [parentRoot[elementType]];
        }
        const includedElements = Array.isArray(includedRoot[elementType])
          ? includedRoot[elementType]
          : [includedRoot[elementType]];
        parentRoot[elementType].push(...includedElements);
      }
    }
  }

  public getSchema(scriptType: string): Schema | undefined {
    return this.schemas.get(scriptType);
  }

  public findElementDefinition(scriptType: string, elementName: string): any[] {
    return this.getSchema(scriptType)?.findElementDefinition(elementName) ?? [];
  }

  public getAllPossibleAttributes(scriptType: string, elementName: string): AttributeOfElement[] {
    return this.getSchema(scriptType)?.getAllPossibleAttributesMap(elementName) ?? [];
  }

  public getAttributePossibleValues(
    scriptType: string,
    elementName: string,
    attributeName: string
  ): AttributeValuesItem[] {
    return this.getSchema(scriptType)?.getAttributePossibleValues(elementName, attributeName) ?? [];
  }

  public getMissingMandatoryAttributes(
    scriptType: string,
    elementName: string,
    existingAttributeNames: string[]
  ): any[] {
    return this.getSchema(scriptType)?.getMissingMandatoryAttributes(elementName, existingAttributeNames) ?? [];
  }

  public getPossibleChildElements(scriptType: string, elementName: string): any[] {
    return this.getSchema(scriptType)?.getPossibleChildElements(elementName) ?? [];
  }

  public elementAttributesByTypes(scriptType: string, elementName: string, types: string[]): string[] {
    return this.getSchema(scriptType)?.elementAttributesByTypes(elementName, types) ?? [];
  }
}
